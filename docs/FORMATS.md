# 파일 포맷 노트 — Live Photo와 Motion Photo는 안에서 어떻게 생겼나

이 문서는 `@photoshare/core`가 읽고 쓰는 바이트 구조를 정리한 것입니다. 근거는 세 가지입니다.

1. **실제 기기 파일**: iPhone 6s 라이브포토(HEIC 대신 JPG+MOV), iPhone 7 HEIC, Galaxy One UI 5/6 모션포토(JPG, HEIC),
   Galaxy S20(One UI 2), Pixel 4 XL / Pixel 7 Pro 모션포토. `scripts/fetch-samples.sh`로 받을 수 있고
   `packages/core/test/real-samples.test.ts`가 이 파일들로 검증합니다.
2. **공식 파서 소스**: Google media3(ExoPlayer)의 `MotionPhotoDescription` / `JpegMotionPhotoExtractor`,
   Android 개발자 문서의 Motion Photo Format 1.0.
3. **exiftool 소스**(Samsung.pm, Apple.pm, QuickTime.pm, Google.pm, Trailer.pm). 테스트에서 exiftool로 우리가 만든 파일을 다시 읽습니다.

## 1. Apple Live Photo = 파일 두 개 + UUID 하나

| 파일 | 어디에 | 무엇을 |
| --- | --- | --- |
| 정지 이미지 (HEIC/JPG) | Exif → MakerNote(`Apple iOS\0` 헤더) → 태그 `0x0011` | `ContentIdentifier` (대문자 UUID 문자열) |
| 영상 (.MOV) | `moov/meta` (hdlr `mdta`) → `keys`/`ilst` | `com.apple.quicktime.content.identifier` = 같은 UUID |
| 영상 (.MOV) | 별도 타임드 메타데이터 트랙 (hdlr `meta`, 샘플 엔트리 `mebx`) | 키 `com.apple.quicktime.still-image-time`. **샘플의 시각**이 정지 사진에 해당하는 프레임 |

세부 사항:

- Apple MakerNote 헤더는 `"Apple iOS\0"` + 버전(u16 BE, 보통 1) + 바이트 순서(`MM`) = 14바이트이고, 그 뒤에 TIFF IFD가 옵니다.
  IFD 안의 오프셋은 **MakerNote 시작 기준**이라 위치와 무관하게 통째로 옮길 수 있습니다.
- `moov/meta`는 QuickTime 스펙상 version/flags 없는 일반 atom입니다(ISO의 `meta`는 FullBox). exiftool도 moov 레벨에서는
  그렇게 읽습니다. ffmpeg는 `moov/udta/meta`(FullBox)에 쓰므로 읽을 때는 둘 다 봅니다.
- still-image-time 트랙은 실제 iPhone MOV와 박스 단위로 동일하게 씁니다(테스트에서 비교). 샘플 하나(`[u32 9][u32 1][i8 -1]`,
  길이 1틱)를 두고, 정지 시각은 `edts/elst`의 **빈 편집(empty edit)** 으로 앞을 비워 표현합니다:
  `elst = [(stillTicks, media_time=-1), (1, 0)]`, 트랙 길이 = stillTicks + 1, 미디어 타임스케일 = 무비 타임스케일(보통 600).
  `tkhd` flags 0xF, `tref/cdsc` → 비디오 트랙, `hdlr` = `mhlr`/`meta`/`appl` + Pascal 문자열 "Core Media Metadata",
  `minf` = `gmhd/gmin` + `dhlr`/`alis` 핸들러 + `dref/alis`, `stsd/mebx/keys` 안에 `keyd`(`mdta` + 키)와 `dtyp`(ns 0, type 65).
  exiftool은 edit list를 무시하므로 SampleTime을 0으로 보여 주지만, 실제 iPhone 파일도 마찬가지입니다.
- iPhone MOV에는 `com.apple.quicktime.creationdate`(예: `2021-04-10T11:44:00+0100`), `.make`, `.model`, `.software` 키도
  있습니다. 정지 사진의 Exif에서 같은 값을 만들어 넣습니다.
- 영상 컨테이너 브랜드는 `qt  `로 바꿉니다. 코덱(H.264/HEVC, AAC)은 그대로입니다.

## 2. Motion Photo = JPEG 뒤에 MP4를 이어 붙인 것

```
[JPEG ... FFD9] [SEF 블록: MotionPhoto_Data 헤더 + MP4] [SEF 블록: Image_UTC_Data] [SEFH 디렉터리] [u32 dirLen] "SEFT"
        ▲ XMP(APP1)에 Google Container/MotionPhoto 메타데이터
```

실제 Galaxy One UI 6 파일(SM-F711N)의 실측값입니다. 우리는 이 배치를 그대로 따릅니다.

| 구간 | 크기 | 비고 |
| --- | --- | --- |
| JPEG (EOI까지) | 4,938,000 | XMP의 Primary `Item:Length`와 동일 |
| SEF `Image_UTC_Data` 블록 | 35 | 8바이트 헤더 + 이름 14 + epoch ms 문자열 13 |
| SEF `MCC_Data`, `Camera_Capture_Mode_Info` 블록 | 19 + 33 | 우리는 쓰지 않음 |
| SEF `MotionPhoto_Data` 블록 헤더 | 24 | 8 + "MotionPhoto_Data" |
| MP4 | 3,274,599 | 여기서부터가 Google이 보는 "video item" |
| SEFH 디렉터리 + `u32 dirLen` + "SEFT" | 68 | 블록 4개 → 12 + 12×4 + 8 |

XMP: Primary `Length=4938000 Padding=111`(EOI→MP4 사이 전체), MotionPhoto `Length=3274667`(= MP4 + 68) `Padding=68`.

### 2.1 Samsung SEF 트레일러 (갤러리가 보는 것)

리틀엔디언. 파일 끝이 `\0\0SEFT`로 끝납니다.

```
block   := u16 0 | u16 type | u32 nameLen | name | data
SEFH    := "SEFH" | u32 version(106) | u32 count | count × (u16 0 | u16 type | u32 negOffset | u32 blockSize)
tail    := u32 dirLen | "SEFT"
```

- `negOffset`은 SEFH 시작 위치에서 블록 시작까지 **뒤로** 센 거리입니다.
- `type 0x0a30` = `MotionPhoto_Data`(MP4 원본), `0x0a01` = `Image_UTC_Data`(epoch ms 문자열).
- 일부 최신 기기는 `0x0a30` 데이터가 12바이트 `mpv2` + 절대 오프셋/크기 형태로만 들어 있습니다. 읽을 때 처리합니다.
- HEIC 모션포토는 같은 구조가 최상위 `sefd` 박스 안에 들어 있거나 파일 끝에 붙어 있습니다.

### 2.2 Google XMP (Google 포토·픽셀·최신 One UI가 보는 것)

```xml
<rdf:Description xmlns:GCamera=".../camera/" xmlns:Container=".../container/" xmlns:Item=".../container/item/"
  GCamera:MotionPhoto="1" GCamera:MotionPhotoVersion="1" GCamera:MotionPhotoPresentationTimestampUs="…"
  GCamera:MicroVideo="1" GCamera:MicroVideoVersion="1" GCamera:MicroVideoOffset="…" GCamera:MicroVideoPresentationTimestampUs="…">
  <Container:Directory><rdf:Seq>
    <rdf:li rdf:parseType="Resource"><Container:Item Item:Mime="image/jpeg" Item:Semantic="Primary" Item:Length="0" Item:Padding="24"/></rdf:li>
    <rdf:li rdf:parseType="Resource"><Container:Item Item:Mime="video/mp4" Item:Semantic="MotionPhoto" Item:Length="<MP4 길이>" Item:Padding="0"/></rdf:li>
  </rdf:Seq></Container:Directory>
</rdf:Description>
```

- **Google의 리더(media3)는 파일 끝에서 거꾸로** 각 보조 항목의 `Item:Length`만큼 물러나며 위치를 정합니다. 앞으로 세지 않습니다.
  그래서 MotionPhoto 항목의 `Length`는 MP4 길이 + 뒤따르는 바이트(삼성 SEF 디렉터리)여야 하고, 삼성도 그렇게 씁니다.
  우리는 `Length = MP4 + 44`(UTC 블록 하나 + 비디오 블록 → 디렉터리 12+24, 꼬리 8), 비디오 `Padding = 44`로 씁니다.
- Primary `Item:Padding`은 EOI에서 MP4 시작까지의 간격(우리 배치에서 35 + 24 = 59), `Item:Length`는 JPEG 자체 길이입니다
  (스펙상 선택 사항이라 Pixel은 0을 씁니다. XMP 길이가 JPEG 길이에 영향을 주므로 값이 안정될 때까지 두세 번 다시 계산합니다).
- `MicroVideoOffset`(구형)은 파일 끝에서 MP4 시작까지의 거리 = MotionPhoto `Length`와 같은 값입니다.
- 스펙은 `video/quicktime`도 허용하지만 삼성 갤러리를 위해 항상 `mp42` 브랜드 MP4로 다시 씁니다.
- HEIC 모션포토: Galaxy One UI 6는 Google 1.1 방식으로 MP4를 최상위 `mpvd` 박스에 담고, 그 뒤 `sefd` 박스에 SEF 구조를 넣되
  `MotionPhoto_Data` 블록은 영상 대신 `mpv2` + 절대 오프셋/크기(12바이트)만 가집니다. XMP는 `mime` 항목으로 들어 있고
  Primary `Length` = HEIF 길이, `Padding` = 8(mpvd 헤더), 비디오 `Length` = mpvd 페이로드 + sefd 크기, `Padding` = sefd 크기.
  읽기는 지원하고, 쓰기는 아직 JPEG로 통일합니다.

### 2.3 읽을 때의 우선순위

1. SEF `MotionPhoto_Data`(HEIC는 `mpvd` → `sefd` → 트레일러) → 2. XMP Container 디렉터리(media3와 같은 역방향 계산, 실패 시 EOI + Padding)
→ 3. `MicroVideoOffset` → 4. EOI 뒤에서 `ftyp` 스캔.
XMP가 적어 둔 길이는 참고만 하고, 실제 MP4 경계는 박스 구조를 따라가며 정합니다(편집 앱이 XMP를 망가뜨린 파일 대비).

## 3. 변환 규칙

| 방향 | 정지 이미지 | 영상 | 키 프레임 |
| --- | --- | --- | --- |
| Motion → Live | 트레일러 제거, XMP의 모션 힌트 제거, Apple MakerNote에 UUID 기록 (HEIC는 Exif 항목을 새 `mdat`에 덧붙이고 `iloc`만 고침) | 브랜드 `qt  `, `moov/meta`에 UUID + creationdate/make/model, still-image-time 트랙 추가. 비디오 트랙은 가장 큰 것 하나만 남기고(Pixel 7 Pro는 저해상도 트랙이 하나 더 있음) 벤더 메타데이터 트랙(`mett`) 제거. 청크 오프셋(stco/co64) 재계산 | `MotionPhotoPresentationTimestampUs` → still-image-time |
| Live → Motion | HEIC면 JPEG로 디코드 후 Exif 이식(Orientation=1로 정규화) | 브랜드 `mp42`, Apple 메타데이터 트랙(still-image-time, live-photo-info) 제거. iPhone의 `lpcm` 오디오는 기본 유지(`dropPcmAudio` 옵션으로 제거 가능) | still-image-time → `PresentationTimestampUs` |

영상 프레임은 어느 방향으로도 재인코딩하지 않습니다. `mdat` 바이트는 동일하게 유지되며 테스트에서 확인합니다.
