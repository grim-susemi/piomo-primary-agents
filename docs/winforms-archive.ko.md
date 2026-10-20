# WinForms 스위처 보관 절차

WinForms 프로필 스위처(`OMO_Native_Profile_Switcher.ps1`)를 지우지 않고 옮겨 두는 절차입니다. 상황판의 "프로필·에이전트" 화면이 그 역할을 이어받습니다.

**지금 상태:** 아직 옮기지 않았습니다. 옮기는 일은 todo 16에서 소유자가 승인했을 때만, 동등성 표가 통과한 뒤에 합니다. `restore.ps1`도 그때 보관 폴더 안에 만들어집니다. 그래서 이 문서의 복원 명령은 아직 실제 보관본에 돌려 본 적이 없고, 임시 사본으로만 확인했습니다.

돌아가기: [README.ko.md](../README.ko.md)

---

### 카드 1. 무엇이 옮겨지나

**규칙:** `C:/Users/USER/Desktop/OpenCode_Modes` 안에서 아래만 옮깁니다. 나머지는 그대로 두고, 아무것도 지우지 않습니다.

- `OMO_Native_Profile_Switcher.ps1`
- `OMO_Native_Recommendation.psm1`, `OMO_Native_Recommendation.json`, `OMO_Native_ReasoningLevels.psm1`
- 스위처가 불러오는(dot-source, import) 다른 `OMO_Native_*.ps1|psm1|json`
- `test/OMO_Native_Profile_Switcher.*`, `tests/OMO_Native_*`
- `docs/piomo-model-role-reference-current.md`
- 내용에 `OMO_Native_Profile_Switcher`가 들어 있는 `.bat`, `.cmd` 실행 파일
- 대상이 스위처를 가리키는 `.lnk` 바로가기

**결과:** 모두 `archive/winforms-switcher-<yyyyMMdd>/`로 옮겨지고, 원래 상대 경로를 그대로 지킵니다. 폴더 밖에서 스위처를 가리키는 바로가기는 승인 질문에 목록으로 나옵니다. 그 바로가기들은 옮긴 뒤 동작하지 않습니다.

### 카드 2. 매니페스트 확인

**무엇:** 보관 폴더의 `manifest.json`에는 옮긴 파일마다 상대 경로와 sha256이 들어 있습니다.

**할 일:** 보관 폴더에서 PowerShell로 해시를 대조합니다.

```powershell
$m = Get-Content manifest.json -Raw | ConvertFrom-Json
$m.files | ForEach-Object { [pscustomobject]@{ path = $_.path; ok = ((Get-FileHash -Algorithm SHA256 $_.path).Hash.ToLower() -eq $_.sha256) } }
```

**결과:** 모든 줄의 `ok`가 `True`입니다. `False`가 있으면 그 파일이 보관 뒤에 바뀐 것이니 복원하지 말고 먼저 원인을 봅니다.

### 카드 3. 되돌리기

**할 일:** 보관 폴더에서 복원 스크립트를 돌립니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\restore.ps1
```

**결과:** 파일이 원래 자리로 돌아갑니다. 스크립트는 todo 16에서 만들어지므로, 돌리기 전에 카드 2로 해시부터 맞춰 보세요.
