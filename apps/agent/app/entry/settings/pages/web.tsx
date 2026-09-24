import { KeyRoundIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { Switch } from "~/components/ui/switch";
import { type KagiStatus } from "../../api";
import { useKagiQuery } from "../../queries/global";
import { useKagiMutation } from "../../queries/mutations/global";
import { errorMessage, PageHeader, PageError } from "../shared";

function KagiBadge({ status }: { status: KagiStatus }) {
  if (status.enabled) return <Badge>켜짐</Badge>;
  if (status.keyRegistered) return <Badge variant="secondary">꺼짐</Badge>;
  return <Badge variant="outline">키 없음</Badge>;
}

/** Kagi Search and Extract (R19): a key in the keychain, then an explicit switch. */
export function KagiSettings() {
  const mutation = useKagiMutation();
  const { data: status } = useKagiQuery();
  const [key, setKey] = useState("");
  const busy = mutation.isPending;
  const [error, setError] = useState<string | null>(null);

  const apply = async (
    command: { action: "register"; key: string } | { action: "remove" | "enable" | "disable" },
  ) => {
    setError(null);
    try {
      await mutation.mutateAsync(command);
      if (command.action === "register") setKey("");
    } catch (failure) {
      setError(errorMessage(failure instanceof Error ? failure : new Error(String(failure))));
    }
  };

  const header = (
    <PageHeader
      title="웹 검색"
      badge={status && <KagiBadge status={status} />}
      description="켜면 모델이 필요할 때 Kagi로 웹을 검색하고 페이지를 읽어요. 모든 프로젝트에 적용되고, 호출마다 Kagi 요금이 나가요."
    />
  );

  return (
    <FieldGroup>
      {header}
      {status.keyRegistered ? (
        <>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="kagi-enabled">검색과 페이지 읽기 사용</FieldLabel>
              <FieldDescription>
                실패해도 다시 시도하지 않아요. 끄면 다음 호출부터 바로 막혀요.
              </FieldDescription>
            </FieldContent>
            <Switch
              id="kagi-enabled"
              checked={status.enabled}
              disabled={busy}
              onCheckedChange={(checked) => void apply({ action: checked ? "enable" : "disable" })}
            />
          </Field>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldTitle>API 키</FieldTitle>
              <FieldDescription>
                OS 키체인에 저장돼 있어요. 화면에 다시 보여주지 않아요.
              </FieldDescription>
            </FieldContent>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void apply({ action: "remove" })}
            >
              <Trash2Icon /> 키 삭제
            </Button>
          </Field>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (key.trim()) void apply({ action: "register", key });
          }}
        >
          <Field>
            <FieldLabel htmlFor="kagi-key">API 키</FieldLabel>
            <div className="flex gap-2">
              <Input
                id="kagi-key"
                type="password"
                autoComplete="off"
                value={key}
                onChange={(event) => setKey(event.target.value)}
                placeholder="kagi.com/api/keys에서 발급한 키"
              />
              <Button type="submit" variant="outline" disabled={busy || !key.trim()}>
                {busy ? <Spinner /> : <KeyRoundIcon />} 저장
              </Button>
            </div>
            <FieldDescription>
              키는 OS 키체인에만 저장되고 모델, 대화, 로그에는 보이지 않아요. 저장해도 저절로
              켜지지는 않아요.
            </FieldDescription>
          </Field>
        </form>
      )}
      <PageError error={error} />
    </FieldGroup>
  );
}
