# 파일 포맷 노트 — Live Photo와 Motion Photo는 안에서 어떻게 생겼나

이 문서는 `@photoshare/core`가 읽고 쓰는 바이트 구조를 정리한 것입니다. 모두 공개 문서와
exiftool 소스(Samsung.pm, Apple.pm, QuickTime.pm, Google.pm, Trailer.pm)를 근거로 했고,
테스트에서 exiftool로 우리가 만든 파일을 다시 읽어 검증합니다.

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
- still-image-time 샘플 페이로드는 `[u32 size=9][u32 local_key_id=1][i8 -1]`이고, 샘플 엔트리 `mebx` 안 `keys` 박스에
  `keyd`(`mdta` + 키 이름)와 `dtyp`(namespace 0, type 65 = int8)를 둡니다. 정지 시각은 `edts/elst`의 빈 편집(empty edit)으로
  앞을 비워 표현합니다. 트랙은 `tref/cdsc`로 비디오 트랙을 가리킵니다.
- 영상 컨테이너 브랜드는 `qt  `로 바꿉니다. 코덱(H.264/HEVC, AAC)은 그대로입니다.

## 2. Motion Photo = JPEG 뒤에 MP4를 이어 붙인 것

```
[JPEG ... FFD9] [SEF 블록: MotionPhoto_Data 헤더 + MP4] [SEF 블록: Image_UTC_Data] [SEFH 디렉터리] [u32 dirLen] "SEFT"
        ▲ XMP(APP1)에 Google Container/MotionPhoto 메타데이터
```

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

- Container 항목은 Primary 이미지의 EOI 바로 뒤부터 순서대로 놓입니다. SEF 블록 헤더(8 + `MotionPhoto_Data` 16 = 24바이트)가
  MP4 앞에 오므로 Primary의 `Item:Padding`을 24로 적습니다.
- `MicroVideoOffset`은 **파일 끝에서 MP4 시작까지**의 거리이므로 MP4 길이 + 뒤따르는 SEF 디렉터리 길이입니다.
- HEIC 모션포토(Google 1.1)는 MP4를 최상위 `mpvd` 박스에 담습니다. 읽기는 지원하고, 쓰기는 JPEG로 통일합니다.

### 2.3 읽을 때의 우선순위

1. SEF `MotionPhoto_Data` → 2. XMP Container 디렉터리 → 3. `MicroVideoOffset` → 4. EOI 뒤에서 `ftyp` 스캔.
XMP가 적어 둔 길이는 참고만 하고, 실제 MP4 경계는 박스 구조를 따라가며 정합니다(편집 앱이 XMP를 망가뜨린 파일 대비).

## 3. 변환 규칙

| 방향 | 정지 이미지 | 영상 | 키 프레임 |
| --- | --- | --- | --- |
| Motion → Live | 트레일러 제거, XMP의 모션 힌트 제거, Apple MakerNote에 UUID 기록 (HEIC는 Exif 항목을 새 `mdat`에 덧붙이고 `iloc`만 고침) | 브랜드 `qt  `, `moov/meta`에 UUID, still-image-time 트랙 추가. 청크 오프셋(stco/co64) 재계산 | `MotionPhotoPresentationTimestampUs` → still-image-time |
| Live → Motion | HEIC면 JPEG로 디코드 후 Exif 이식(Orientation=1로 정규화) | 브랜드 `mp42`, Apple 메타데이터 트랙 제거 | still-image-time → `PresentationTimestampUs` |

영상 프레임은 어느 방향으로도 재인코딩하지 않습니다. `mdat` 바이트는 동일하게 유지되며 테스트에서 확인합니다.
