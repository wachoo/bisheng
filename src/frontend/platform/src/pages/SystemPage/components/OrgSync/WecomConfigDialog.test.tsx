import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from '@bisheng/ui';

import {
  createOrgSyncConfigApi,
  updateOrgSyncConfigApi,
} from '@/controllers/API/orgSync';
import type { OrgSyncConfig } from '@/types/api/orgSync';
import { WecomConfigDialog } from './WecomConfigDialog';

vi.mock('@/controllers/API/orgSync', () => ({
  createOrgSyncConfigApi: vi.fn(),
  updateOrgSyncConfigApi: vi.fn(),
}));
vi.mock('@/controllers/request', () => ({ showApiError: vi.fn() }));

function makeConfig(overrides: Partial<OrgSyncConfig> = {}): OrgSyncConfig {
  return {
    id: 1,
    provider: 'wecom',
    config_name: 'config-1',
    auth_type: 'api_key',
    auth_config: {},
    sync_scope: null,
    schedule_type: 'manual',
    cron_expression: null,
    sync_status: 'idle',
    last_sync_at: null,
    last_sync_result: null,
    status: 'active',
    create_user: 1,
    create_time: null,
    update_time: null,
    ...overrides,
  };
}

function fillCreateForm() {
  fireEvent.change(screen.getByLabelText('form.configName'), {
    target: { value: 'gzb' },
  });
  fireEvent.change(screen.getByLabelText('wecom.corpid'), {
    target: { value: 'ww123' },
  });
  fireEvent.change(screen.getByLabelText('wecom.corpsecret'), {
    target: { value: 'secret' },
  });
  fireEvent.change(screen.getByLabelText('wecom.agentId'), {
    target: { value: '1000002' },
  });
}

function renderDialog(
  props: Partial<React.ComponentProps<typeof WecomConfigDialog>> = {},
) {
  return render(
    <WecomConfigDialog
      open
      onOpenChange={vi.fn()}
      editing={null}
      siblings={[]}
      onSaved={vi.fn()}
      {...props}
    />,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(toast, 'show').mockImplementation(() => '');
  vi.mocked(updateOrgSyncConfigApi).mockResolvedValue(makeConfig());
});

describe('WecomConfigDialog', () => {
  it('blocks an incomplete create and never calls the API', async () => {
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'actions.save' }));

    expect(await screen.findByText('validation.nameRequired')).toBeInTheDocument();
    expect(screen.getByText('wecom.corpidRequired')).toBeInTheDocument();
    expect(createOrgSyncConfigApi).not.toHaveBeenCalled();
  });

  it('creates a config and retires the other active one', async () => {
    const onSaved = vi.fn();
    vi.mocked(createOrgSyncConfigApi).mockResolvedValue(makeConfig({ id: 9 }));
    const sibling = makeConfig({ id: 2, status: 'active' });

    renderDialog({ siblings: [sibling], onSaved });
    fillCreateForm();
    fireEvent.click(screen.getByRole('button', { name: 'actions.save' }));

    await waitFor(() =>
      expect(createOrgSyncConfigApi).toHaveBeenCalledWith({
        provider: 'wecom',
        config_name: 'gzb',
        auth_type: 'api_key',
        auth_config: {
          corpid: 'ww123',
          agent_id: '1000002',
          corpsecret: 'secret',
        },
        schedule_type: 'manual',
      }),
    );
    expect(updateOrgSyncConfigApi).toHaveBeenCalledWith(2, { status: 'disabled' });
    expect(onSaved).toHaveBeenCalled();
    expect(toast.show).toHaveBeenCalledWith({ type: 'success', message: 'createSuccess' });
  });

  it('keeps the stored secret when the edit form still shows the mask', async () => {
    const editing = makeConfig({
      id: 5,
      config_name: 'existing',
      auth_config: { corpid: 'ww9', corpsecret: '****', agent_id: '1000003' },
    });

    renderDialog({ editing, siblings: [editing] });
    fireEvent.click(screen.getByRole('button', { name: 'actions.save' }));

    await waitFor(() =>
      expect(updateOrgSyncConfigApi).toHaveBeenCalledWith(5, {
        config_name: 'existing',
        auth_config: { corpid: 'ww9', agent_id: '1000003' },
        status: 'active',
      }),
    );
    expect(toast.show).toHaveBeenCalledWith({ type: 'success', message: 'updateSuccess' });
  });

  it('creates the config disabled when the switch is off', async () => {
    vi.mocked(createOrgSyncConfigApi).mockResolvedValue(makeConfig({ id: 8 }));

    renderDialog();
    fillCreateForm();
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(screen.getByRole('button', { name: 'actions.save' }));

    await waitFor(() => expect(createOrgSyncConfigApi).toHaveBeenCalled());
    expect(updateOrgSyncConfigApi).toHaveBeenCalledWith(8, { status: 'disabled' });
  });
});
