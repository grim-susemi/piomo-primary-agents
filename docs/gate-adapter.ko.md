# 게이트 어댑터 가이드

`plan-review-unlock` 정책이 적용된 환경에서는 실행 뒤에도 소유자가 요청한 계획 검토를 허용합니다. 다시 실행해도 재잠금하지 않습니다. 명시적인 계획 요청·실제 계획 파일·검토 신원·단회 실행 조건은 유지하며, 이 환경에는 추가 어댑터가 필요하지 않습니다.

아래 어댑터는 실행 이력 잠금이 남아 있는 이전 정책의 선택적 호환 수단입니다. omo 플러그인의 `omo-task.js`에 한 줄을 넣고 정확한 설치 전 바이트로 되돌릴 수 있습니다. 확장은 새 정책과 이전 어댑터를 구분해 확인하며, 둘 다 확인하지 못했을 때만 설정 확인을 안내합니다. 자동으로 잠금을 해제하거나 설치하지 않습니다.

> 현재 상태: 아래 명령은 모두 임시 사본에서만 실행해 봤습니다. 실제(live) `omo-task.js` 설치는 아직 하지 않았고, 주인의 승인 단계(todo 16 (e))에서만 진행합니다.

---

## 바뀌는 것은 규칙 하나

| 항목 | 내용 |
|---|---|
| 넣는 문장 | `if(R==="ulw-plan"){T.get(A)?.delete("ulw-execute")}` (변수 이름은 번들마다 다르며 앵커에서 읽음) |
| 위치 | 게이트 입력 처리기의 `/skill:` 분기, `return` 바로 앞 |
| 표시 | `/*piomo-primary-agents:gate-adapter:v1:begin*/` ... `/*piomo-primary-agents:gate-adapter:v1:end*/` |
| 의미 | 주인이 직접 입력한 `/skill:ulw-plan`이 실행 이력만 지움. 이전 정책은 다음 실행 때 다시 잠그지만, 새 전역 허용 정책은 실행 이력으로 검토를 잠그지 않음 |
| 바꾸지 않는 것 | `requiresSkills`, `requiresPlanArtifact`, 그 밖의 에이전트 정책 전부. 확장이 보낸 메시지(`source: "extension"`)는 게이트가 원래 무시하므로 잠금을 풀 수 없음 |

---

## 준비

### 카드 1. 대상 경로 정하기

**할 일**: PowerShell에서 EXT 폴더로 이동하고, 대상 파일과 상태 폴더를 변수에 담습니다.

```powershell
cd C:\Users\USER\orca\projects\piomo-primary-agents
$Target = "<omo-task.js 경로>"
$State  = "<상태 폴더 경로>"
```

**결과**: 아무것도 쓰지 않습니다. 상태 폴더는 설치할 때 생기며, 안에 `manifest.json`과 원본 백업 `omo-task.js.preimage`가 들어갑니다.

---

## 설치

### 카드 2. 상태 보기

**할 일**:

```powershell
node scripts/gate-adapter.mjs status --target $Target --state-dir $State
```

**결과**: 종료 코드 0, `"status":"not-installed"`, `"anchor_count":1`. 앵커가 정확히 하나여야 설치할 수 있습니다.

### 카드 3. 미리 보기

**할 일**:

```powershell
node scripts/gate-adapter.mjs install --target $Target --state-dir $State --dry-run
```

**결과**: 종료 코드 0, `"status":"would-install"`, `"wrote":false`. 넣을 문장(`statement`)과 설치 전후 sha256이 나옵니다. 파일은 그대로예요.

### 카드 4. 설치

**할 일**:

```powershell
node scripts/gate-adapter.mjs install --target $Target --state-dir $State
```

**결과**: 종료 코드 0, `"status":"installed"`, `"wrote":true`. 원본은 상태 폴더에 백업되고, 대상은 같은 폴더 안에서 원자적으로 교체됩니다. 설치한 파일은 `node --check`를 통과했어요.

### 카드 5. 다시 설치해 보기

**할 일**: 카드 4 명령을 한 번 더 실행합니다.

**결과**: 종료 코드 0, `"status":"applied"`, `"wrote":false`. 이미 들어가 있으면 아무것도 쓰지 않습니다.

### 카드 6. 설치 확인

**할 일**: 카드 2 명령을 실행합니다.

**결과**: 종료 코드 0, `"status":"applied"`, `"managed":true`, 백업 경로 표시.

---

## 제거와 되돌리기

### 카드 7. 제거

**할 일**:

```powershell
node scripts/gate-adapter.mjs uninstall --target $Target --state-dir $State
```

**결과**: 종료 코드 0, `"status":"uninstalled"`. 대상이 설치 전 바이트와 똑같아지고, 상태 폴더의 매니페스트와 백업은 지워집니다(폴더가 비면 폴더도).

### 카드 8. 되돌리기(rollback)

**할 일**:

```powershell
node scripts/gate-adapter.mjs rollback --target $Target --state-dir $State
```

**결과**: 종료 코드 0, `"status":"rolled-back"`. 제거와 같은 보호 절차로 원본을 복원합니다. 이름만 다르고 하는 일은 같아요.

### 카드 9. 누가 파일을 바꿨을 때

**할 일**: 설치 뒤 대상이 바뀐 상태에서 카드 2와 카드 7을 실행합니다.

**결과**: 둘 다 종료 코드 1. 상태는 `"status":"drift"`, `"reason":"TARGET_DRIFT_REFUSED"`, 제거는 `TARGET_DRIFT_REFUSED`로 거부하고 아무것도 쓰지 않습니다.

---

## 조정(coordination) 어댑터와의 순서

`piomo-agent-coordination-mod`도 같은 `omo-task.js`를 고칩니다. 순서를 지켜야 서로의 백업이 맞아요.

### 카드 10. 설치 순서

**할 일**: 조정 어댑터를 먼저 설치하고, 그다음 카드 4로 게이트 어댑터를 설치합니다.

**결과**: 게이트 어댑터는 조정 어댑터가 적용된 파일을 자기 원본으로 기록합니다. 조정 어댑터가 없는 순정 파일 위에서도 똑같이 동작해요(todo 17 테스트가 두 경우를 다 확인).

### 카드 11. 제거 순서

**할 일**: 조정 어댑터를 지우거나 다시 설치하기 전에, 카드 7로 게이트 어댑터를 먼저 제거합니다.

**결과**: 대상이 조정 어댑터만 적용된 상태로 돌아갑니다. 순서를 거꾸로 하면 게이트 어댑터의 기록과 파일이 어긋나서 카드 9처럼 거부됩니다.

---

## omo 업데이트 루틴

omo를 업데이트하면 `omo-task.js`가 새 파일로 바뀌고 게이트 어댑터도 사라집니다. 업데이트할 때마다 다시 적용하세요.

### 카드 12. 업데이트 뒤 다시 적용

**할 일**: 업데이트 뒤 조정 어댑터를 먼저 다시 적용합니다. 그다음 이전 상태 폴더는 그대로 두고 빈 새 상태 폴더를 `$State`로 정한 뒤 카드 2, 카드 4를 실행합니다.

**결과**: 앵커가 하나면 `"status":"installed"`. 이전 상태 폴더에는 업데이트 전 파일의 백업이 남아 있으니 지우지 말고 보관하세요.

### 카드 13. 앵커를 못 찾을 때

**할 일**: 새 버전에서 카드 4를 실행했더니 거부된 경우입니다.

**결과**: 종료 코드 1, `"reason":"ANCHOR_COUNT_REFUSED: expected 1, found 0"`. 대상 파일은 그대로이고 상태 폴더도 만들지 않습니다. 이때 Prometheus는 다시 계획하기가 잠겨 있다는 안내로 돌아갑니다. 어댑터를 새 번들에 맞게 고치기 전까지는 새 세션에서 계획을 시작하세요.

---

## 알려진 한계

- 실제 설치는 하지 않았습니다. live `omo-task.js` 적용과 "ulw-execute 뒤 새 계획 요청이 계획 검토를 다시 연다"는 실사용 확인은 todo 16 (e)에서 합니다.
- 위 결과는 omo 플러그인 `omo-task.js`의 임시 사본에서 확인한 것입니다. 다른 버전에서는 앵커가 달라 카드 13처럼 거부될 수 있어요.
- 처음 보는 거부 코드(`EXISTING_BACKUP_REFUSED` 등)가 나오면 손으로 파일을 고치지 말고 상태부터 확인하세요.

관련 문서: [README](../README.ko.md)
