# rules

## Overview
`tools/oxlint/anti-slop/rules`는 저장소의 anti-slop oxlint 플러그인을 이루는 개별 규칙 파일을 모은 디렉터리다. 각 파일은 `vite-plus/lint/plugins`의 `defineRule`로 규칙 하나를 정의해 export한다. 규칙들은 AST 수준에서 다음을 막는다: 타입 단언 남용, `unknown`/`any`/`object`/열린 dictionary 같은 넓은 타입, 런타임 `typeof`, `Reflect.apply`/`Reflect.get`, 모듈 mocking, 조건부 빈 객체 spread, 심볼 이름의 "shape". 공통 로직은 `tools/oxlint/anti-slop/shared`(`function-parameters.ts`, `type-alias-resolution.ts`, `dictionary-types.ts`, `reflect-method.ts`)에서 가져온다.

## Interface
- `noChainedTypeAssertionsRule` — `as`/`<T>` 단언이 2개 이상 이어진 체인(괄호 포함)을 금지한다. 체인 전체가 `as const`뿐이면 허용한다(messageId `chained`).
- `noConditionalEmptyObjectSpreadRule` — 객체 리터럴 안에서 `...(cond ? {...} : {})`처럼 한쪽 분기가 빈 객체인 조건부 spread를 금지한다(messageId `avoid`).
- `noKnownValueWideningRule` — 문법상 이미 알려진 값이 명시적으로 넓은 타입이나 익명 대상 타입으로 흘러가 타입 증거를 잃는 경우를 보고한다(messageId `widening`).
- `noModuleMockingRule` — `vi`/`jest`의 `mock`·`doMock`·`unstable_mockModule` 호출을 금지한다. 의존성은 실제 인터페이스로 주입해야 한다(messageId `moduleMock`).
- `noObjectParametersRule` — 함수 파라미터 타입이 `object`이거나 로컬 alias·union을 거쳐 `object`로 풀리는 경우를 금지한다(messageId `objectParameter`).
- `noReflectApplyRule` — 전역 `Reflect.apply` 호출을 금지한다(messageId `reflectApply`).
- `noReflectGetRule` — 전역 `Reflect.get` 호출을 금지한다(messageId `reflectGet`).
- `noRuntimeTypeofRule` — `typeof` 연산자 사용을 금지한다. 옵션 `allowInTypeGuards`(기본 false)로 type predicate 함수 안에서는 허용할 수 있다(messageId `runtimeTypeof`).
- `noForbiddenTermInSymbolNamesRule` — Identifier/PrivateIdentifier/JSXIdentifier 이름에 대소문자 무관 부분 문자열 "shape"가 들어가면 금지한다(messageId `forbiddenSymbolName`).
- `noUnknownParametersRule` — 명시적 `unknown` 파라미터를 금지한다. 이름이 `cause`인 파라미터와 type predicate 대상은 예외다(messageId `unknownParameter`).
- `noUnknownReturnsRule` — 반환 타입이 alias 해석 후 `unknown`, `Promise<unknown>`, `PromiseLike<unknown>`이거나 이를 포함한 union이면 금지한다(messageId `unknownReturn`).
- `noUnknownTypeAliasesRule` — 해석 결과가 `unknown`(또는 이를 포함한 union)인 type alias 선언을 금지한다(messageId `unknownAlias`).
- `noUnsafeDictionaryTypeRule` — 값 타입이 `unknown`/`any`/`object`/`{}`이거나 이를 담은 union·alias인 dictionary 타입(type reference, type literal, mapped type, index signature)을 금지한다(messageId `unsafeDictionary`).
- `noWidenThenAssertRule` — 알려진 값을 `const` 바인딩에서 top(`unknown`/`any`)·`object`·넓은 `Record<string|number|symbol|PropertyKey, unknown|any>` 타입으로 넓힌 뒤 다시 단언으로 좁히는 패턴을 탐지한다.
- `requireSafetyCommentForTypeAssertionRule` — `as const`가 아닌 모든 타입 단언 앞에 `SAFETY:` 형식의 근거 주석을 요구한다. 옵션 `markers`로 마커를 바꿀 수 있다(messageId `missingSafetyComment`).

## Invariants
- 모든 규칙은 `defineRule({ meta, createOnce(context) })` 형태다. `createOnce`는 visitor 객체를 반환하고, 위반은 `context.report({ node, messageId, data })`로만 알린다.
- type-alias 환경이 필요한 규칙(`noObjectParametersRule`, `noUnknownReturnsRule`, `noUnknownTypeAliasesRule`, `noUnsafeDictionaryTypeRule`, `noKnownValueWideningRule`)은 `Program` visitor에서 `createTypeAliasEnvironment`/`createTypeEnvironment(node, context.sourceCode.visitorKeys)`로 파일마다 환경을 다시 만든다. 환경이 `null`이면 보고하지 않는다.
- `as const` 단언은 `noChainedTypeAssertionsRule`에서 체인 전체가 const일 때 허용된다. `requireSafetyCommentForTypeAssertionRule`에서는 항상 면제된다.
- SAFETY 주석 조건: 주석이 단언 시작 위치보다 앞에서 끝나야 한다. 주석 위치는 단언 자신, 조상 노드, 또는 가장 가까운 `ExpressionStatement`/`PropertyDefinition`/`ReturnStatement`/`ThrowStatement`/`VariableDeclaration`(이 문장을 직접 감싼 `export` 선언 포함) 앞이어야 한다. 내용은 정규식 `(?:^|[^\p{L}\p{N}_])(?:MARKER)\s*:\s*\S`에 맞아야 한다. 기본 마커는 `SAFETY`이고, 비거나 잘못된 `markers` 옵션은 기본값으로 대체된다.
- `noUnknownParametersRule`의 예외는 파라미터 이름 `cause`와 type predicate 대상 파라미터 두 가지뿐이다.
- `noRuntimeTypeofRule`은 `typeof x === "undefined"` 같은 존재 확인(`===`/`!==`/`==`/`!=`와 literal `"undefined"` 비교)을 항상 허용한다. 다른 `typeof`는 `allowInTypeGuards: true`이고 가장 가까운 함수 반환 타입이 `TSTypePredicate`일 때만 허용된다.
- `noModuleMockingRule`이 test framework 객체로 인정하는 것: 전역 `vi`/`jest`, 해석되지 않는 `vi`/`jest` 식별자, `vitest`·`vite-plus/test`에서 import한 `vi`, `@jest/globals`에서 import한 `jest`. computed 접근(`vi["mock"]`)도 잡는다.
- `noForbiddenTermInSymbolNamesRule`은 다른 값이 소유한 non-computed member 속성 이름(`obj.shapeX`의 `shapeX`)은 보고하지 않는다. 선언·참조 식별자는 모두 보고한다.
- 값 증거 추적(`noKnownValueWideningRule`의 `hasKnownEvidence`/`hasKnownCallArgumentEvidence`, `noWidenThenAssertRule`의 `knownValueEvidence`/`widenedBinding`)은 `const` 선언이면서 초기화 외에 쓰기 참조가 없는 바인딩만 따라간다. `noWidenThenAssertRule`은 추가로 같은 함수 경계 안의 바인딩만 따라간다.
- 재귀 순환 방지 키는 `declarator.start` 오프셋이다. 한 소스 파일 안에서 선언 오프셋은 유일하므로, 변하는 scope 객체나 순환하는 AST 부모를 해시하지 않는다.
- `noUnsafeDictionaryTypeRule`은 type parameter constraint 안의 타입을 보고하지 않는다. type alias 선언 밖에서 타입 인자 없이 쓴 alias 참조도 보고하지 않는다. 불안전 dictionary로 분류된 조상 타입이 있으면 가장 바깥 노드만 보고한다. `TSTypeLiteral` 안의 `TSIndexSignature`는 따로 보고하지 않는다.
- `noWidenThenAssertRule`의 넓은 타입 분류(`BroadTypeKind`)는 세 가지다. `top`은 `unknown`/`any`, `object`는 `object` keyword다. `record`는 `Record`/`Readonly<Record>`/단일 index signature literal 중 키가 `string`/`number`/`symbol`/`PropertyKey`이고 값이 `unknown`/`any`인 경우다.
- 규칙 코드의 집합·캐시는 네이티브 Set/Map 대신 Effect 자료구조(`HashSet`, `MutableHashSet`, `MutableHashMap`, `Option`)를 쓴다.

## Side Effects
- 외부 I/O(파일 시스템, 네트워크, DB, 환경 변수, 타이머)는 없다. 진단 결과는 lint host의 `context.report`로만 보낸다.
- `requireSafetyCommentForTypeAssertionRule`은 `createOnce` 클로저 안의 `MutableHashMap`에 마커 조합별 컴파일된 `RegExp`를 캐시한다.
- type-alias 환경 규칙들은 `Program` visitor에서 클로저 변수 `environment`를 다시 설정한다.

## Verification
- Run: `vp lint` (저장소 루트, anti-slop 플러그인을 불러옴)
