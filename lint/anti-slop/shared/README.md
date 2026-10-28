# shared

## Overview
`lint/anti-slop/shared`는 anti-slop Oxlint 플러그인 규칙들이 함께 쓰는 ESTree 분석 도우미 모음이다. 타입 별칭 해석(어휘적 가림 반영, 타입 매개변수 치환), 함수 매개변수의 타입 주석과 바인딩 이름 추출, 전역 `Reflect` 메서드 호출 판별, 안전하지 않은 딕셔너리 타입과 넓히기 대상 분류를 맡는다. `rules/no-unsafe-dictionary-type.ts`는 `classifyUnsafeDictionary`를 쓰고, `rules/no-known-value-widening.ts`는 `classifyWideningTarget`과 `isKnownEvidenceExpression`을 쓴다. 모든 코드는 `vite-plus/lint/plugins`의 ESTree 타입 위에서 동기로 돈다. 자료구조로는 effect의 `HashSet`·`MutableHashMap`·`MutableHashSet`·`Option`을 쓴다.

## Interface
- `createTypeEnvironment(program, visitorKeys)` — 최상위(export 포함) `TSInterfaceDeclaration`을 이름별로 모으고 `createTypeAliasEnvironment` 결과를 묶어 `TypeEnvironment`를 만든다
- `TypeEnvironment` — `interfaces`(이름→인터페이스 선언 배열 MutableHashMap)와 `typeAliases`(`TypeAliasEnvironment`)를 가진 타입
- `classifyUnsafeDictionaryValue(valueType, environment)` — 값 타입이 `unknown`/`any`/`object`/빈 객체/안전하지 않은 멤버를 가진 union이면 `UnsafeDictionary`를 돌려주고, 아니면 null을 돌려준다
- `classifyUnsafeDictionary(type, environment)` — 딕셔너리 형태(인덱스 시그니처, mapped type, `Record`, `Pick`/`Omit`, 별칭)의 값 타입을 펼쳐 안전하지 않은 값을 찾는다. `rules/no-unsafe-dictionary-type.ts`가 쓴다
- `UnsafeDictionary` — `{ kind: "unsafe-dictionary", unsafeValue: "any" | "empty-object" | "object" | "union" | "unknown" }`
- `classifyWideningTarget(type, environment)` — 주석 타입이 넓히기 대상(`WideningTarget`)인지 분류한다. `rules/no-known-value-widening.ts`가 쓴다
- `WideningTarget` / `WideningTargetKind` — `"anonymous object" | "generic container" | "object" | "open dictionary" | "unknown"` 종류 태그
- `isPopulatedObjectExpression(expression)` — 객체 식이 채워져 있는지 판별하는 boolean 도우미이다(본문은 읽기 한도 밖이고, 그래프에서 호출처가 확인되지 않았다)
- `isKnownEvidenceExpression(expression)` — 식이 값이 알려졌다는 근거인지 판별한다. `no-known-value-widening`의 `hasKnownEvidence`·`hasKnownCallArgumentEvidence`가 쓴다
- `containsUnknownType(type)` — 타입이 `unknown`이거나 괄호·union 안에 `unknown`을 가지면 true를 돌려준다
- `functionParameterTypeAnnotation(parameter)` — `TSParameterProperty`·`RestElement`·`AssignmentPattern`을 풀어 매개변수의 `TSTypeAnnotation`을 찾는다
- `functionParameterBindingName(parameter, sourceCode)` — 타입 주석과 기본값을 뺀 지역 바인딩 이름 또는 패턴 원문을 돌려준다
- `FunctionParameter` — `ESTree.ParamPattern` 별칭
- `lexicalTypeParameterNames(node, visitorKeys)` — 노드에서 보이는 타입 바인더를 모은다. 조상의 `typeParameters`, mapped type 키, conditional type의 trueType 안에서 보이는 `infer` 이름이 들어간다
- `isGlobalReflectMethodCall(sourceCode, callee, methodName)` — callee가 가려지지 않은 전역 `Reflect`의 지정 메서드(점 접근 또는 문자열 리터럴 computed 접근)인지 판별한다
- `createTypeAliasEnvironment(program, visitorKeys)` — 프로그램 안의 타입 별칭과 경쟁 타입 바인딩을 이름별로 모은다. 바인딩에는 interface, enum, class, import specifier가 들어가며, 결과는 Program별로 캐시된다
- `TypeAliasEnvironment` — `aliases`, `bindingsByName`, `visitorKeys`를 가진 타입
- `visibleTypeAlias(name, use, environment)` — 어휘적 가림을 반영해 사용 지점에서 가장 가까운 유일한 별칭 선언을 찾고, 없으면 null을 돌려준다
- `hasVisibleTypeBinding(name, use, environment)` — 사용 지점에서 같은 이름의 지역 타입 바인딩이나 타입 매개변수가 내장 타입을 가리는지 판별한다
- `resolvedTypeMatches(type, environment, matcher)` — 보이는 별칭을 펼치고 타입 매개변수를 치환한 뒤 사용자 `ResolvedTypeMatcher`로 재귀 매칭한다
- `ResolvedTypeMatcher` — `(type, matches: (child) => boolean) => boolean` 콜백 타입
- 하위 디렉터리 없음

## Invariants
- `Record`, `Readonly`, `Partial`, `Required`, `Pick`, `Omit`, `PropertyKey`, `NonNullable`은 `hasVisibleTypeBinding`이 false일 때만 내장 타입으로 다룬다. 같은 이름의 지역 선언·import·타입 매개변수가 보이면 내장 타입으로 해석하지 않는다
- 투명 래퍼(`Readonly`/`Partial`/`Required`/`NonNullable`)와 `TSParenthesizedType`, `readonly` 연산자는 벗겨서 안쪽 타입으로 판정한다
- 별칭 순환은 해석 중 집합으로 끊는다. dictionary-types는 별칭 이름을 키로 쓰고(`resolvingAliases`), `resolvedTypeMatches`는 `alias.start` 오프셋을 키로 쓴다. 오프셋은 이 프로그램 안의 선언을 식별하며 가려진 이름도 구별한다(주석에 근거)
- `visibleTypeAlias`는 가장 가까운 스코프의 바인딩이 정확히 1개이고 그것이 별칭일 때만 별칭을 돌려준다. 같은 거리에 바인딩이 여럿이거나 타입 매개변수가 이름을 가리면 null을 돌려준다
- 타입 스코프 경계는 `Program`, `BlockStatement`, `TSModuleBlock`, `StaticBlock`, `SwitchStatement`이다
- 별칭 치환에서 인자가 없으면 매개변수 기본값을 쓴다. 인자와 기본값이 모두 없으면 치환을 포기하고(null) 해당 경로는 안전하다고 본다. `resolvedTypeMatches`에서 명시 인자는 호출 지점 치환(base)으로, 기본값은 진행 중인 치환(next)으로 평가한다
- `createTypeAliasEnvironment`는 Program 객체를 키로 하는 모듈 수준 WeakMap에 결과를 캐시한다. 같은 Program에는 같은 환경 객체를 재사용하므로 결과를 바꾸면 안 된다
- AST 순회는 Oxlint `visitorKeys`가 가리키는 자식 속성만 따른다(SAFETY 주석: visitor keys는 ESTree 자식 노드 속성만 식별한다)
- 빈 객체 판정에서 모든 멤버가 `?: never`인 타입 리터럴과 인터페이스는 비어 있다고 본다. 인터페이스는 선언이 하나이고 `extends`가 없을 때만 해당한다
- intersection은 멤버 중 하나라도 `any`면 `any`로 판정한다. 그 밖에는 모든 멤버가 안전하지 않을 때만 첫 멤버의 분류를 돌려준다. union은 멤버 하나라도 안전하지 않으면 `union`이다
- `Reflect`는 전역 참조이거나 정의(defs)가 없는 변수로 해석될 때만 전역으로 인정한다. 지역에서 다시 선언한 `Reflect`는 제외한다

## Side Effects
- `type-alias-resolution.ts`의 모듈 수준 `environmentsByProgram` WeakMap 캐시에 Program별 `TypeAliasEnvironment`를 쓴다(프로세스 메모리 안에서만 바뀐다)
- 그 밖에 파일 시스템, 네트워크, DB, 타이머, 환경 변수 접근은 없다. 나머지는 AST만 읽는 순수 계산이다

## Verification
- Run: `vp lint` (저장소 루트, anti-slop 플러그인을 불러옴)
