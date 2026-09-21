# 실기기 테스트 체크리스트

파일 구조는 실제 촬영본·공식 파서와 대조해 맞췄지만, 최종 판정은 기기가 합니다. 아래 순서로 한 번씩만 확인하면
남은 불확실성이 대부분 사라집니다. 결과(성공/실패, 기기 모델, OS 버전)를 이슈로 남겨 주세요.

## 준비

```bash
pnpm install && pnpm build
scripts/fetch-samples.sh          # 공개 실기기 샘플 → samples/
pnpm test                         # real-samples 테스트까지 통과하는지 확인
```

## A. 갤럭시 → 아이폰 (모션포토 → 라이브포토)

1. 갤럭시에서 모션포토 한 장을 **원본 그대로** PC로 옮깁니다(USB/MTP 또는 Quick Share).
   `node packages/cli/dist/bin.js inspect 파일.jpg` 가 `kind: motion-photo` 라고 나와야 합니다.
2. 변환: `node packages/cli/dist/bin.js to-live 파일.jpg -o out/` → `파일.jpg` + `파일.mov`.
3. 아이폰에 넣기(택 1):
   - **Google 포토**: photos.google.com에 두 파일을 함께 업로드 → 아이폰 Google 포토 앱에서 열기 → 움직이면 성공.
     "기기에 저장" 후 iOS 사진 앱에서 **LIVE** 배지가 붙는지 확인.
   - **iCloud 웹**: icloud.com/photos → 업로드 → 두 파일 동시 선택 → 아이폰 사진 앱에서 LIVE 배지 확인.
   - **Mac 사진 앱**: 두 파일을 함께 가져오기 → 사진 앱에서 Live 배지 → iCloud 동기화 또는 AirDrop.
4. 확인 항목:
   - [ ] LIVE 배지가 붙고 길게 눌렀을 때 재생된다.
   - [ ] 정지 사진에서 영상으로 넘어갈 때 튀지 않는다(키 프레임 시각이 맞음). `inspect`가 보여 주는 `key frame`이 촬영 시점과 비슷해야 합니다. 삼성은 보통 영상 끝 근처(2.5~2.9초).
   - [ ] 촬영 일시·카메라 정보가 유지된다.
   - [ ] 소리가 난다(삼성 모션포토는 AAC라 재생되어야 함).

## B. 아이폰 → 갤럭시 (라이브포토 → 모션포토)

1. 아이폰에서 라이브포토를 PC로 옮깁니다. **원본 유지**가 중요합니다:
   - Mac: 사진 앱 → 파일 → 내보내기 → **수정되지 않은 원본 내보내기** (HEIC + MOV 두 파일).
   - Windows: iCloud for Windows의 다운로드(원본), 또는 USB로 DCIM에서 `IMG_xxxx.HEIC` + `IMG_xxxx.MOV`.
   - AirDrop으로 Mac에 보내면 HEIC+MOV가 함께 옵니다.
2. 변환: `node packages/cli/dist/bin.js to-motion IMG_xxxx.HEIC IMG_xxxx.MOV -o out/IMG_xxxx.jpg`
   (`identifiers matched`가 출력되면 원본 쌍이 맞다는 뜻).
3. 갤럭시에 넣기: USB로 `DCIM/Camera/`에 복사, 또는 Quick Share / 카카오톡 "원본으로 보내기".
   일반 사진 전송(재압축)은 영상을 잘라내므로 피합니다.
4. 확인 항목:
   - [ ] 갤러리 썸네일에 모션포토 아이콘이 뜨고, 사진을 열어 "모션 포토 보기"(또는 길게 누르기)로 재생된다.
   - [ ] Google 포토 앱에서도 자동 재생/모션 배지가 뜬다.
   - [ ] 정지 프레임과 영상이 자연스럽게 이어진다(키 프레임 = MOV의 still-image-time).
   - [ ] 소리: 재생되면 좋고, 안 되면 `--drop-pcm-audio`로 다시 만들어 갤러리가 파일을 거부하지 않는지 확인.
   - [ ] HEIC를 JPEG로 바꾼 화질이 허용 범위인지 (`--quality 95`로 조절 가능).

## C. 알려진 함정

- iOS "파일" 앱에서 JPG와 MOV를 각각 "이미지 저장"하면 **짝이 맞춰지지 않습니다**. 위 경로를 쓰세요.
- 메신저·클라우드 동기화 앱은 재압축하며 트레일러(영상)를 잘라냅니다. 항상 "원본" 옵션.
- 갤럭시 갤러리가 새 파일을 늦게 인식하면 파일을 한 번 열거나 미디어 스캔(재부팅)을 해 주세요.

## D. 실패 시 첨부하면 좋은 것

- 원본 파일(가능하면), `node packages/cli/dist/bin.js inspect --json 파일` 출력
- 기기 모델, OS/One UI 버전, 넣은 경로(Google 포토/iCloud/Mac/USB)
- 어떤 단계에서 어떻게 보였는지(배지 없음 / 재생 안 됨 / 파일 안 열림)
