# PhotoShare — 아이폰 ↔ 갤럭시, 움직이는 사진을 그대로

아이폰의 **라이브포토**(Live Photo)와 갤럭시·픽셀의 **모션포토**(Motion Photo)는 같은 "찰나의 영상이 붙은 사진"이지만
파일 구조가 달라서 기기 사이를 건너면 움직임이 사라지고 정지 사진만 남습니다. PhotoShare는 두 포맷을 **재인코딩 없이**
서로 변환합니다. 영상 프레임, 촬영 정보(EXIF), 키 프레임 시점까지 유지됩니다.

| 방향 | 입력 | 출력 |
| --- | --- | --- |
| 갤럭시 → 아이폰 | 모션포토 `IMG.jpg` (또는 HEIC) | 라이브포토 한 쌍 `IMG.jpg` + `IMG.mov` |
| 아이폰 → 갤럭시 | 라이브포토 `IMG.HEIC`/`IMG.JPG` + `IMG.MOV` | 모션포토 `IMG.jpg` (삼성 갤러리 + Google 포토 모두 인식) |

세 가지 형태로 제공됩니다.

- **웹 앱** (`apps/web`) — 브라우저에서 끌어다 놓기만 하면 끝. 파일은 어디로도 업로드되지 않습니다.
- **CLI** (`packages/cli`) — 폴더째 일괄 변환.
- **라이브러리** (`packages/core`) — 의존성 0개의 TypeScript. Node와 브라우저에서 동일하게 동작.

## 빠른 시작

```bash
pnpm install
pnpm test                       # 포맷 파서/라이터 테스트 (exiftool·ffmpeg로 교차 검증)
pnpm build                      # core + cli 빌드
pnpm dev:web                    # 웹 앱 개발 서버

# CLI
node packages/cli/dist/bin.js inspect  IMG_0001.jpg
node packages/cli/dist/bin.js to-live  갤럭시사진.jpg -o out/          # → out/갤럭시사진.jpg + .mov
node packages/cli/dist/bin.js to-motion IMG_0001.HEIC IMG_0001.MOV -o 모션.jpg
node packages/cli/dist/bin.js convert  ./사진폴더 -o ./변환결과          # 방향 자동 판별, 일괄
node packages/cli/dist/bin.js extract  모션.jpg                        # 정지 사진 + mp4로 분리
```

## 변환한 파일을 실제로 넣는 방법

**아이폰**은 "사진에 저장"으로 JPG와 MOV를 따로 저장하면 짝이 맞춰지지 않습니다. 쌍으로 가져오는 경로를 쓰세요.

1. **Google 포토**: PC에서 JPG + MOV를 함께 업로드 → 아이폰 Google 포토 앱에서 "기기에 저장" → 사진 앱에 라이브포토로 저장.
2. **iCloud 웹**(icloud.com/photos): 업로드에서 두 파일을 동시에 선택.
3. **Mac 사진 앱**: 두 파일을 함께 가져오기 → iCloud 동기화 또는 AirDrop.

**갤럭시**는 결과 JPG 하나를 원본 그대로 옮기기만 하면 갤러리가 모션포토로 인식합니다(USB, Quick Share, 메신저 "원본 전송").
일반 사진 전송은 재압축하면서 영상을 잘라내니 피하세요.

## 어떻게 동작하나

- 라이브포토는 사진의 Apple MakerNote(`ContentIdentifier`)와 MOV의 `com.apple.quicktime.content.identifier`가 같은 UUID를
  가질 때 성립합니다. 여기에 키 프레임 시각을 담은 `still-image-time` 메타데이터 트랙을 MOV에 추가합니다.
- 모션포토는 JPEG 뒤에 MP4를 이어 붙이고, 삼성 SEF 트레일러(`MotionPhoto_Data`)와 Google XMP(`Container:Directory`,
  `GCamera:MotionPhoto`, 구형 `MicroVideo`)로 위치를 알려 줍니다. 세 가지를 모두 써서 어떤 갤러리든 인식하게 합니다.
- 영상은 컨테이너 박스만 고치고(`ftyp` 브랜드, `moov`, 청크 오프셋) 미디어 데이터는 손대지 않습니다.
- HEIC 정지 사진은 Motion → Live 방향에서는 원본 HEIC를 유지하고(Exif만 덧붙임), Live → Motion 방향에서는 모션포토 규격상
  JPEG로 디코드합니다(브라우저: Safari 네이티브 또는 libheif WASM, Node: libheif WASM + jpeg-js).

자세한 바이트 구조는 [docs/FORMATS.md](docs/FORMATS.md)에 있습니다.

## 검증

`pnpm test`는 우리가 만든 파일을 **exiftool**로 다시 읽어 삼성 트레일러, Google XMP, Apple MakerNote, QuickTime Keys,
still-image-time 트랙이 모두 인식되는지 확인하고, **ffmpeg**로 변환된 영상이 끝까지 디코드되는지 확인합니다.
실제 기기(iOS 사진 앱, 삼성 갤러리, Google 포토)에서의 최종 확인은 아직 자동화되어 있지 않으니, 문제가 있는 샘플은
이슈로 올려 주세요.

## 알려진 한계 (v0.1)

- 아이폰 → 갤럭시 방향은 JPEG 모션포토만 만듭니다(HEIC 모션포토 쓰기는 로드맵).
- 조각난(fragmented) MP4는 지원하지 않습니다. 폰 카메라 출력은 해당되지 않습니다.
- iOS에 직접 저장하는 앱은 아직 없습니다. 위 "넣는 방법"의 경로를 사용하세요.

## 저장소 구조

```
packages/core   @photoshare/core  — JPEG/Exif/XMP/SEF/ISOBMFF 파서·라이터, 변환 로직 (의존성 없음)
packages/cli    @photoshare/cli   — photoshare 명령
apps/web        @photoshare/web   — Vite 정적 웹 앱 (GitHub Pages 배포 워크플로 포함)
docs/           포맷 노트
```

MIT License.
