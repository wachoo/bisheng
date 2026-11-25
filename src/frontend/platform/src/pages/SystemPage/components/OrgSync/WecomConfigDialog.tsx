import { Button, Input, Modal, Switch, toast } from '@bisheng/ui';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  createOrgSyncConfigApi,
  updateOrgSyncConfigApi,
} from '@/controllers/API/orgSync';
import { showApiError } from '@/controllers/request';
import type { OrgSyncConfig } from '@/types/api/orgSync';

/** A '****' on a secret field means "keep the stored value" (see the backend update merge). */
const MASKED_SECRET = '****';

interface WecomConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Config being edited; `null` opens the create form. */
  editing: OrgSyncConfig | null;
  /** Every existing WeCom config, used to keep at most one active. */
  siblings: OrgSyncConfig[];
  onSaved: () => void;
}

interface WecomFormState {
  name: string;
  corpid: string;
  corpsecret: string;
  agentId: string;
  enabled: boolean;
}

type FieldErrors = Partial<Record<keyof WecomFormState, string>>;

const EMPTY_FORM: WecomFormState = {
  name: '',
  corpid: '',
  corpsecret: '',
  agentId: '',
  enabled: true,
};

export function WecomConfigDialog({
  open,
  onOpenChange,
  editing,
  siblings,
  onSaved,
}: WecomConfigDialogProps) {
  const { t } = useTranslation('orgSync');
  const [form, setForm] = useState<WecomFormState>(EMPTY_FORM);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);

  const isEdit = !!editing;

  useEffect(() => {
    if (!open) return;
    setErrors({});
    if (editing) {
      const auth = (editing.auth_config || {}) as Record<string, unknown>;
      setForm({
        name: editing.config_name,
        corpid: String(auth.corpid ?? ''),
        corpsecret: String(auth.corpsecret ?? MASKED_SECRET),
        agentId: String(auth.agent_id ?? ''),
        enabled: editing.status === 'active',
      });
      return;
    }
    setForm(EMPTY_FORM);
  }, [open, editing]);

  const patch = (next: Partial<WecomFormState>) => {
    setForm((prev) => ({ ...prev, ...next }));
  };

  const validate = (): boolean => {
    const next: FieldErrors = {};
    if (!form.name.trim()) next.name = t('validation.nameRequired');
    if (!form.corpid.trim()) next.corpid = t('wecom.corpidRequired');
    if (!form.corpsecret.trim()) {
      next.corpsecret = t('wecom.corpsecretRequired');
    } else if (!isEdit && form.corpsecret === MASKED_SECRET) {
      next.corpsecret = t('wecom.corpsecretCannotBeMasked');
    }
    if (!form.agentId.trim()) next.agentId = t('wecom.agentIdRequired');
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSave = async () => {
    if (saving || !validate()) return;
    setSaving(true);
    try {
      const authConfig: Record<string, unknown> = {
        corpid: form.corpid.trim(),
        agent_id: form.agentId.trim(),
      };
      // Keep the stored secret when the edit form still shows the mask.
      if (!(isEdit && form.corpsecret === MASKED_SECRET)) {
        authConfig.corpsecret = form.corpsecret.trim();
      }

      if (form.enabled) {
        // The login entry requires exactly one active config (19331); retire the others first.
        const others = siblings.filter(
          (config) => config.status === 'active' && config.id !== editing?.id,
        );
        for (const other of others) {
          await updateOrgSyncConfigApi(other.id, { status: 'disabled' });
        }
      }

      if (editing) {
        await updateOrgSyncConfigApi(editing.id, {
          config_name: form.name.trim(),
          auth_config: authConfig,
          status: form.enabled ? 'active' : 'disabled',
        });
      } else {
        const created = await createOrgSyncConfigApi({
          provider: 'wecom',
          config_name: form.name.trim(),
          auth_type: 'api_key',
          auth_config: authConfig,
          schedule_type: 'manual',
        });
        // Creation defaults to active; turn it off when the operator saved it disabled.
        if (!form.enabled) {
          await updateOrgSyncConfigApi(created.id, { status: 'disabled' });
        }
      }

      toast.show({
        type: 'success',
        message: isEdit ? t('updateSuccess') : t('createSuccess'),
      });
      onOpenChange(false);
      onSaved();
    } catch (error) {
      showApiError(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? t('dialog.editTitle') : t('dialog.createTitle')}
      closeLabel={t('actions.close')}
      size="medium"
      submitting={saving}
      footer={
        <>
          <Button
            variant="outlined"
            color="default"
            disabled={saving}
            onClick={() => onOpenChange(false)}
          >
            {t('actions.cancel')}
          </Button>
          <Button loading={saving} onClick={() => void handleSave()}>
            {t('actions.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-body font-normal text-text-1">
            {t('form.configName')}
            <span className="text-destructive"> *</span>
          </span>
          <Input
            value={form.name}
            status={errors.name ? 'error' : 'default'}
            placeholder={t('form.configNamePlaceholder')}
            aria-label={t('form.configName')}
            onChange={(event) => patch({ name: event.target.value })}
          />
          {errors.name && (
            <span className="text-caption text-destructive">{errors.name}</span>
          )}
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-body font-normal text-text-1">
            {t('wecom.corpid')}
            <span className="text-destructive"> *</span>
          </span>
          <Input
            value={form.corpid}
            status={errors.corpid ? 'error' : 'default'}
            placeholder={t('wecom.corpidPlaceholder')}
            aria-label={t('wecom.corpid')}
            onChange={(event) => patch({ corpid: event.target.value })}
          />
          {errors.corpid && (
            <span className="text-caption text-destructive">{errors.corpid}</span>
          )}
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-body font-normal text-text-1">
            {t('wecom.corpsecret')}
            <span className="text-destructive"> *</span>
          </span>
          <Input
            type="password"
            autoComplete="new-password"
            value={form.corpsecret}
            status={errors.corpsecret ? 'error' : 'default'}
            placeholder={
              isEdit
                ? t('wecom.corpsecretMaskedHint')
                : t('wecom.corpsecretPlaceholder')
            }
            aria-label={t('wecom.corpsecret')}
            onChange={(event) => patch({ corpsecret: event.target.value })}
          />
          {errors.corpsecret && (
            <span className="text-caption text-destructive">{errors.corpsecret}</span>
          )}
          {isEdit && form.corpsecret === MASKED_SECRET && (
            <span className="text-caption text-text-3">{t('wecom.corpsecretEditHint')}</span>
          )}
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-body font-normal text-text-1">
            {t('wecom.agentId')}
            <span className="text-destructive"> *</span>
          </span>
          <Input
            value={form.agentId}
            status={errors.agentId ? 'error' : 'default'}
            placeholder={t('wecom.agentIdPlaceholder')}
            aria-label={t('wecom.agentId')}
            onChange={(event) => patch({ agentId: event.target.value })}
          />
          {errors.agentId && (
            <span className="text-caption text-destructive">{errors.agentId}</span>
          )}
        </label>

        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-3">
            <Switch
              checked={form.enabled}
              onCheckedChange={(checked) => patch({ enabled: checked })}
              aria-label={t('form.enabled')}
            />
            <span className="text-body text-text-1">{t('form.enabled')}</span>
          </div>
          {form.enabled && (
            <span className="text-caption text-text-3">{t('configs.exclusiveHint')}</span>
          )}
        </div>
      </div>
    </Modal>
  );
}
