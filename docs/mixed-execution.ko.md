# 혼합 계획 인계

한 계획 안에 성격이 다른 작업이 섞여도 총괄은 한 명입니다. 이 문서는 두 가지 예시를 정의합니다.

1. **한 계획 안에서**: 총괄 Sisyphus가 기술 Todo 하나를 Native `task`의 `category: deep-low`로 위임하고, 이어지는 인수 Todo에서 직접 검수합니다.
2. **분리한 하위 계획**: 독립 검증이 필요한 기술 구간을 `lead-mixed-restore` 하위 계획으로 분리하고, 그 계획만 `Execution lead: hephaestus`로 명시 실행합니다. 상위 계획 `lead-mixed-parent`의 총괄은 Sisyphus 한 명입니다.

두 경로 모두 쓰기 경로가 겹치지 않아야 하고, 인수 Todo는 기술 작업 다음에 옵니다. 인수 증거가 없거나 실패하면 인수 Todo를 완료하지 않으며, 그 뒤의 의존 작업과 최종 합격도 진행하지 않습니다.

## 공통 인수 계약

기술 작업의 결과는 아래 파일과 값으로 남깁니다.

```json
{
  "schema": "mixed-execution/save-restore/v1",
  "restored": true,
  "writeScope": ["src/core/state.mjs", "test/core-state.test.mjs"],
  "tests": { "command": "node --test --test-isolation=none test/core-state.test.mjs", "exitCode": 0 },
  "evidenceSha256": "<evidence file SHA-256>"
}
```

인수 Todo는 아래를 **직접 읽어** 확인한 뒤에만 완료합니다.

| 확인 항목 | 합격 조건 | 실패 시 |
| --- | --- | --- |
| 결과 파일 | `save-restore.json`이 존재하고 `restored: true` | 인수 Todo 미완료 |
| 시험 | 기록된 시험 명령의 종료 코드 `0` | 인수 Todo 미완료 |
| 쓰기 범위 | 기술 Todo에 배정된 경로만 변경 | 인수 Todo 미완료 |
| 증거 해시 | 인수 증거에 적은 SHA-256과 실제 파일 해시가 같음 | 인수 Todo 미완료 |
| 총괄 | `acceptedBy: sisyphus` 한 명 | 인수 Todo 미완료 |

인수 증거에는 `acceptedBy: sisyphus`와 같은 SHA-256을 남깁니다. 같은 파일의 작성자가 둘로 기록되면 인수는 실패입니다.

## 예시 1: 한 계획 안에서 (same-plan)

상위 계획 `lead-mixed`의 TL;DR:

```
Execution lead: sisyphus
Execution rationale: 저장 복구는 기술 작업 하나와 총괄 인수 한 번으로 닫는다
```

Todo 구성:

- **Todo 1. 저장 복구 구현** — Native `task`에 `category: deep-low`로 위임합니다. 작업자는 이 Todo의 `Recommended task executor category: deep-low`와 `Loadout: programming`을 그대로 따르고, Todo에 적힌 `src/core/state.mjs`와 `test/core-state.test.mjs`만 씁니다. 일반 Native 자식 작업의 PiOMO 역할을 바꾸거나 Hephaestus로 표시하지 않습니다.
- **Todo 2. 총괄 인수** — Todo 1에 의존합니다. Sisyphus가 `save-restore.json`, 시험 종료 코드, 쓰기 범위, 증거 SHA-256을 직접 확인하고 `acceptedBy: sisyphus`를 남긴 뒤 완료합니다.

쓰기 경로: Todo 1만 `src/core/state.mjs`와 `test/core-state.test.mjs`를 씁니다. Todo 2는 `.omo/evidence/lead-mixed/`의 증거만 씁니다.

## 예시 2: 분리한 하위 계획 (separate sub-plan)

하위 계획 `lead-mixed-restore`의 TL;DR:

```
Execution lead: hephaestus
Execution rationale: 저장 복구 구간만 독립 검증 가능한 하위 계획으로 분리한다
```

상위 계획 `lead-mixed-parent`의 TL;DR:

```
Execution lead: sisyphus
Execution rationale: 하위 계획 결과를 인수해 최종 합격을 판정한다
```

1. 소유자가 `/ulw-execute lead-mixed-restore`를 명시 실행합니다. Hephaestus가 역할을 맡고, 하위 작업 완료 시 `save-restore.json`과 하위 완료 기록의 SHA-256을 증거로 남깁니다.
2. 하위 작업 종료 뒤 이 두 파일만 상위 작업공간의 `.omo/evidence/lead-mixed-restore/`로 전달합니다.
3. 별도 pane에서 소유자가 `/ulw-execute lead-mixed-parent`를 명시 실행합니다. Sisyphus 총괄이 인수 Todo에서 `acceptedBy: sisyphus`와 실제 파일의 같은 SHA-256을 확인한 뒤에만 첫 의존 Todo를 위임합니다.

실패 대조: 하위 완료 기록은 유지하고 전달 파일 바이트만 바꾸면, 상위 인수 Todo는 미완료이고 첫 의존 위임과 최종 합격은 각각 0건이어야 합니다.

## 하지 않는 것

- 새 제품용 승인 저장소나 Native 도구를 추가하지 않습니다.
- 상위 계획의 총괄을 두 명으로 나누지 않습니다.
- 인수 없이 다음 의존 작업이나 최종 합격을 진행하지 않습니다.
- 실제 Hephaestus 역할은 분리 하위 계획의 명시 실행에서만 씁니다.
