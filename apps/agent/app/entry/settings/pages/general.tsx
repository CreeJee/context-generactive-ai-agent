import { Trans, useLingui } from "@lingui/react/macro";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "~/components/ui/field";
import { ThemeField } from "../../shared/theme";
import { PageHeader, pageTitles } from "../shared";

/** Settings of the app itself: how it looks, and where to report a problem. */
export function GeneralSettings({ reportLink }: { readonly reportLink: string }) {
  const { t } = useLingui();
  return (
    <FieldGroup>
      <PageHeader
        title={t(pageTitles.general)}
        description={<Trans>앱의 모양과 문제 제보입니다.</Trans>}
      />
      <ThemeField />
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel>
            <Trans comment="Field label: the problem report page">문제 제보</Trans>
          </FieldLabel>
          <FieldDescription>
            <Trans comment="Description of the problem report link field">
              증상과 진단 정보를 모아 개발자에게 보냅니다. 열려 있는 대화에 대한 제보 화면으로
              이동합니다.
            </Trans>
          </FieldDescription>
        </FieldContent>
        <a href={reportLink} className="text-sm text-primary underline">
          <Trans comment="Link that opens the problem report page">제보 화면 열기</Trans>
        </a>
      </Field>
    </FieldGroup>
  );
}
