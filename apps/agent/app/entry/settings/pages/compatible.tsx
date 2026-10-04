import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import {
  compatibleClient,
  compatibleQueryKey,
  type CompatibleConfiguration,
  type CompatibleUpdate,
} from "../compatible-client";
import { PageError, PageHeader } from "../shared";

export function CompatibleSettings() {
  const { data } = useSuspenseQuery({
    queryKey: compatibleQueryKey,
    queryFn: compatibleClient.status,
  });
  return (
    <CompatibleForm
      key={JSON.stringify([
        data.configuration?.baseUrl,
        data.configuration?.model,
        data.configuration?.contextWindow,
        data.configuration?.outputBudget,
        data.configuration?.toolCalling,
      ])}
      configuration={data.configuration}
      hasApiKey={data.hasApiKey}
    />
  );
}

function CompatibleForm({
  configuration,
  hasApiKey,
}: {
  configuration: CompatibleConfiguration | null;
  hasApiKey: boolean;
}) {
  const client = useQueryClient();
  const [form, setForm] = useState<CompatibleConfiguration>(
    configuration ?? {
      baseUrl: "",
      model: "",
      contextWindow: 32768,
      outputBudget: 4096,
      toolCalling: true,
    },
  );
  const [key, setKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [models, setModels] = useState<readonly { id: string }[]>([]);
  const mutation = useMutation({
    mutationFn: async (
      command: { action: "update"; value: CompatibleUpdate } | { action: "test" | "list" },
    ) => {
      setMessage(null);
      if (command.action === "update") {
        await compatibleClient.update(command.value);
        setKey("");
        setRemoveKey(false);
        await client.invalidateQueries();
        setMessage("저장했어요.");
      } else if (command.action === "test") {
        await compatibleClient.test();
        setMessage("연결을 확인했어요.");
      } else {
        const result = await compatibleClient.list();
        setModels(result.models);
        await client.invalidateQueries({ queryKey: compatibleQueryKey });
        setMessage(
          `${result.models.length}개 모델을 불러왔어요. 목록에 없어도 모델 ID를 직접 입력할 수 있어요.`,
        );
      }
    },
  });
  const busy = mutation.isPending;
  return (
    <FieldGroup>
      <PageHeader
        title="OpenAI 호환 공급자"
        description="Chat Completions 호환 서버를 연결해요. 구독 계정 로그인과 별개이며, 공급자의 API 사용 요금이 적용될 수 있어요."
      />
      <form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate({
            action: "update",
            value: {
              ...form,
              baseUrl: form.baseUrl.trim(),
              model: form.model.trim(),
              ...(removeKey ? { apiKey: null } : key.trim() ? { apiKey: key.trim() } : {}),
            },
          });
        }}
      >
        <Field>
          <FieldLabel htmlFor="compatible-url">Base URL</FieldLabel>
          <Input
            id="compatible-url"
            type="url"
            required
            value={form.baseUrl}
            placeholder="https://api.example.com/v1"
            onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
          />
          <FieldDescription>
            API 기본 주소를 입력하세요. /chat/completions 경로는 자동으로 붙어요. 키가 등록된
            상태에서 서버 주소를 바꾸려면 새 키를 입력하거나 기존 키 삭제를 선택하세요.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="compatible-key">API 키 (선택)</FieldLabel>
          <Input
            id="compatible-key"
            type="password"
            autoComplete="off"
            value={key}
            disabled={removeKey}
            placeholder={hasApiKey ? "등록된 키 유지" : "키 없는 로컬 서버도 연결할 수 있어요"}
            onChange={(event) => setKey(event.target.value)}
          />
          <FieldDescription>
            키는 OS 키체인에 저장되고 다시 표시되지 않아요. 비워 두면 기존 키를 유지해요.
          </FieldDescription>
          {hasApiKey && (
            <div className="flex items-center gap-2">
              <Switch
                id="compatible-remove-key"
                checked={removeKey}
                onCheckedChange={setRemoveKey}
              />
              <FieldLabel htmlFor="compatible-remove-key">저장할 때 기존 키 삭제</FieldLabel>
            </div>
          )}
        </Field>
        <Field>
          <FieldLabel htmlFor="compatible-model">모델 ID</FieldLabel>
          <Input
            id="compatible-model"
            required
            value={form.model}
            onChange={(event) => setForm({ ...form, model: event.target.value })}
          />
          {models.length > 0 && (
            <div className="flex flex-wrap gap-2" aria-label="서버의 추천 모델">
              {models.slice(0, 20).map(({ id }) => (
                <Button
                  key={id}
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setForm({ ...form, model: id })}
                >
                  {id}
                </Button>
              ))}
            </div>
          )}
          <FieldDescription>
            서버에서 사용하는 정확한 ID를 입력하세요. 모델 목록 조회를 지원하지 않아도 직접 설정할
            수 있어요.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="compatible-context">컨텍스트 창 (토큰)</FieldLabel>
          <Input
            id="compatible-context"
            type="number"
            required
            min={1024}
            max={10000000}
            step={1}
            value={form.contextWindow}
            onChange={(event) => setForm({ ...form, contextWindow: Number(event.target.value) })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="compatible-output">최대 출력 토큰</FieldLabel>
          <Input
            id="compatible-output"
            type="number"
            required
            min={1}
            max={form.contextWindow - 1}
            step={1}
            value={form.outputBudget}
            onChange={(event) => setForm({ ...form, outputBudget: Number(event.target.value) })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="compatible-tools">도구 호출 지원</FieldLabel>
          <Switch
            id="compatible-tools"
            checked={form.toolCalling}
            onCheckedChange={(checked) => setForm({ ...form, toolCalling: checked })}
          />
          <FieldDescription>모델과 서버가 도구 호출을 지원할 때만 켜세요.</FieldDescription>
        </Field>
        <FieldDescription>
          추론 강도는 모델 목록에서 공개된 지원 정보를 자동으로 확인해요. 정보가 없는 모델은 서버
          기본값을 사용하고, 추론 내용은 서버가 보내면 표시해요.
        </FieldDescription>
        <Button type="submit" disabled={busy}>
          저장
        </Button>
      </form>
      <FieldDescription>
        연결 테스트와 모델 목록 새로고침은 마지막으로 저장한 설정을 사용해요.
      </FieldDescription>
      <div className="flex gap-2">
        <Button
          variant="outline"
          disabled={busy || !configuration}
          onClick={() => mutation.mutate({ action: "test" })}
        >
          연결 테스트
        </Button>
        <Button
          variant="outline"
          disabled={busy || !configuration}
          onClick={() => mutation.mutate({ action: "list" })}
        >
          모델 목록 새로고침
        </Button>
      </div>
      {message && (
        <p role="status" className="text-sm text-muted-foreground">
          {message}
        </p>
      )}
      <PageError error={mutation.error?.message ?? null} />
    </FieldGroup>
  );
}
