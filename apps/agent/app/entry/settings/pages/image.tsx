import { useState } from "react";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "~/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { type CrossProviderMediaConsentMode } from "../../api";
import { useSuspenseImageSettingsQuery } from "../../queries/global";
import {
  useCrossProviderConsentMutation,
  useImageGenerationEnabledMutation,
} from "../../queries/mutations/global";
import { PageHeader } from "../shared";

function isCrossProviderMediaConsentMode(
  value: string | null,
): value is CrossProviderMediaConsentMode {
  return value === "disabled" || value === "ask" || value === "always";
}

export function ImageSettings() {
  const enabledMutation = useImageGenerationEnabledMutation();
  const consentMutation = useCrossProviderConsentMutation();
  const { data: status } = useSuspenseImageSettingsQuery();
  const busy = enabledMutation.isPending || consentMutation.isPending;
  const [error, setError] = useState<string | null>(null);

  const setImageGenerationEnabled = async (enabled: boolean) => {
    setError(null);
    try {
      await enabledMutation.mutateAsync(enabled);
    } catch {
      setError("이미지 설정을 바꾸지 못했어요.");
    }
  };

  const applyCrossProviderMode = async (mode: CrossProviderMediaConsentMode) => {
    setError(null);
    try {
      await consentMutation.mutateAsync(mode);
    } catch {
      setError("공급자 간 이미지 실행 동의를 바꾸지 못했어요.");
    }
  };

  const header = (
    <PageHeader
      title="이미지 생성"
      badge={
        status && (
          <Badge variant={status.imageGenerationEnabled ? "secondary" : "outline"}>
            {status.imageGenerationEnabled ? "사용 중" : "꺼짐"}
          </Badge>
        )
      }
      description="이미지 생성이 필요할 때만 작성창에서 생성 모드를 선택해 사용해요. 일반 대화에는 이미지 도구가 추가되지 않아요."
    />
  );

  return (
    <FieldGroup>
      {header}
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="image-generation-enabled">이미지 생성 사용</FieldLabel>
          <FieldDescription>
            OpenAI API 키가 필요하며 생성할 때마다 비용이 발생할 수 있어요. 설정은 바로 적용되고
            앱을 다시 시작할 필요가 없어요.
          </FieldDescription>
        </FieldContent>
        <Switch
          id="image-generation-enabled"
          checked={status.imageGenerationEnabled}
          disabled={busy}
          onCheckedChange={(checked) => void setImageGenerationEnabled(checked)}
        />
      </Field>
      <Alert>
        <AlertDescription>
          켜도 이미지는 자동으로 생성되지 않아요. 작성창에서 이미지 생성 모드를 선택한 요청만
          처리하고, 유료 실행 전에는 별도로 확인해요.
        </AlertDescription>
      </Alert>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="cross-provider-media">Claude에서 이미지 생성</FieldLabel>
          <FieldDescription>
            Claude 사용 중 이미지 생성을 요청하면 프롬프트를 OpenAI로 보내요. 사용량은 OpenAI 계정에
            귀속되며, 로그인만으로 자동 허용되지 않아요.
          </FieldDescription>
        </FieldContent>
        <Select
          value={
            status.crossProviderMediaConsent.pairs["anthropic->openai:media.image.generate"] ??
            "disabled"
          }
          disabled={busy || !status.imageGenerationEnabled}
          onValueChange={(value) => {
            if (isCrossProviderMediaConsentMode(value)) void applyCrossProviderMode(value);
          }}
        >
          <SelectTrigger id="cross-provider-media" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="disabled">사용 안 함</SelectItem>
            <SelectItem value="ask">매번 확인</SelectItem>
            <SelectItem value="always">항상 허용</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </FieldGroup>
  );
}
