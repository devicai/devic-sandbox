import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Divider,
  Form,
  InputNumber,
  Select,
  Slider,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowsRotate,
  faFire,
  faTriangleExclamation,
} from '@fortawesome/free-solid-svg-icons';
import {
  useHotPoolStatus,
  useReconcileHotPool,
  useUpdateHotPoolConfig,
} from '../../hooks/useHotPool';
import { useSnapshots } from '../../hooks/useSnapshots';
import type { HotPoolConfig } from '../../api/types';

const { Text, Paragraph } = Typography;

const FORM_ITEM = { marginBottom: 12 } as const;

const HotPoolSettingsCard: React.FC = () => {
  const { data, isLoading } = useHotPoolStatus();
  const { data: snapshots } = useSnapshots();
  const update = useUpdateHotPoolConfig();
  const reconcile = useReconcileHotPool();
  const [form, setForm] = useState<HotPoolConfig | null>(null);

  useEffect(() => {
    if (data?.config && !form) {
      setForm(data.config);
    }
  }, [data, form]);

  const dirty = useMemo(() => {
    if (!data || !form) return false;
    return JSON.stringify(form) !== JSON.stringify(data.config);
  }, [form, data]);

  const snapshotOptions = useMemo(() => {
    return (snapshots?.data ?? [])
      .filter((s) => s.status === 'ready')
      .map((s) => ({
        value: s.snapshotId,
        label: `${s.name}  ·  ${s.image}  ·  ${(s.sizeBytes / 1024 / 1024).toFixed(1)} MiB`,
      }));
  }, [snapshots]);

  if (isLoading || !form) {
    return <Card size="small" loading title="Hot Pool" style={{ marginTop: 24 }} />;
  }

  const onChange = <K extends keyof HotPoolConfig>(key: K, value: HotPoolConfig[K]) =>
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));

  const handleSave = async () => {
    if (!form) return;
    try {
      await update.mutateAsync(form);
      message.success('Hot pool config updated');
    } catch (err: any) {
      message.error(err?.response?.data?.message ?? err?.message ?? 'Update failed');
    }
  };

  const handleReset = () => {
    if (data?.config) setForm(data.config);
  };

  const totalLimit = data?.metrics.totalLimitMib;
  const reservedPct = form.memoryReservePercent ?? 0;
  const memPer = form.memoryMibPerSandbox ?? 0;
  const projectedSlots =
    totalLimit && memPer > 0
      ? Math.floor((totalLimit * reservedPct) / 100 / memPer)
      : null;

  return (
    <Card
      size="small"
      style={{ marginTop: 24 }}
      title={
        <Space size={10}>
          <FontAwesomeIcon icon={faFire} style={{ color: form.enabled ? '#ff7a45' : '#888' }} />
          <span>Hot Pool</span>
          <Badge
            status={form.enabled ? 'success' : 'default'}
            text={form.enabled ? 'enabled' : 'disabled'}
          />
        </Space>
      }
      extra={
        <Tooltip title="Force reconcile">
          <Button
            size="small"
            icon={<FontAwesomeIcon icon={faArrowsRotate} />}
            onClick={() => reconcile.mutate()}
            loading={reconcile.isPending}
            disabled={!form.enabled}
          />
        </Tooltip>
      }
    >
      <Paragraph type="secondary" style={{ marginTop: 0, fontSize: 13 }}>
        Pre-warm a fleet of sandboxes restored from a snapshot. When a session
        is started with <code>useHotPool: true</code> (or via{' '}
        <code>POST /hot-pool/claim</code>), one of these is handed over instantly
        and a new pod is provisioned to fill the slot.
      </Paragraph>

      <Form layout="vertical" component="div">
        <Form.Item label="Enabled" style={FORM_ITEM}>
          <Switch
            checked={form.enabled}
            onChange={(v) => onChange('enabled', v)}
            disabled={!form.snapshotId && !form.enabled}
          />
          {!form.snapshotId && (
            <Text type="secondary" style={{ marginLeft: 12, fontSize: 12 }}>
              Pick a snapshot to enable
            </Text>
          )}
        </Form.Item>

        <Form.Item label="Source snapshot" style={FORM_ITEM}>
          <Select
            placeholder="Choose a ready snapshot…"
            value={form.snapshotId || undefined}
            options={snapshotOptions}
            onChange={(v) => onChange('snapshotId', v)}
            allowClear
            showSearch
            optionFilterProp="label"
          />
        </Form.Item>

        <Form.Item
          label={
            <Space size={8}>
              <span>Memory reserve (% of total cap)</span>
              {totalLimit ? (
                <Tag>{totalLimit} MiB total</Tag>
              ) : (
                <Tooltip title="No total memory cap configured (resourceLimits.maxTotalMemoryMib). The pool will fall back to minSize / targetSize.">
                  <FontAwesomeIcon icon={faTriangleExclamation} style={{ color: '#faad14' }} />
                </Tooltip>
              )}
            </Space>
          }
          style={FORM_ITEM}
        >
          <Slider
            min={0}
            max={90}
            step={5}
            value={form.memoryReservePercent ?? 0}
            onChange={(v) => onChange('memoryReservePercent', v as number)}
            marks={{ 0: '0%', 25: '25%', 50: '50%', 75: '75%' }}
          />
        </Form.Item>

        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <Form.Item label="Memory per sandbox (MiB)" style={{ ...FORM_ITEM, flex: 1, minWidth: 180 }}>
            <InputNumber
              min={64}
              max={32768}
              step={64}
              value={form.memoryMibPerSandbox}
              onChange={(v) => onChange('memoryMibPerSandbox', v ?? undefined)}
              style={{ width: '100%' }}
            />
          </Form.Item>
          <Form.Item label="vCPUs" style={{ ...FORM_ITEM, flex: 1, minWidth: 120 }}>
            <InputNumber
              min={1}
              max={32}
              value={form.cpus}
              onChange={(v) => onChange('cpus', v ?? undefined)}
              style={{ width: '100%' }}
            />
          </Form.Item>
        </div>

        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <Form.Item label="Min pool size" style={{ ...FORM_ITEM, flex: 1, minWidth: 140 }}>
            <InputNumber
              min={0}
              max={1000}
              value={form.minSize}
              onChange={(v) => onChange('minSize', v ?? undefined)}
              style={{ width: '100%' }}
            />
          </Form.Item>
          <Form.Item
            label={
              <Tooltip title="Optional safety ceiling. Clear the field to let the reserve % be the only cap.">
                <span>Max pool size</span>
              </Tooltip>
            }
            style={{ ...FORM_ITEM, flex: 1, minWidth: 140 }}
          >
            <InputNumber
              min={1}
              max={1000}
              value={form.maxSize ?? undefined}
              // null = explicit "clear" so the backend drops the persisted value;
              // undefined would just be omitted from the PUT body.
              onChange={(v) => onChange('maxSize', (v ?? null) as any)}
              placeholder="no cap"
              style={{ width: '100%' }}
            />
          </Form.Item>
          <Form.Item
            label={
              <Tooltip title="Overrides percentage-based sizing when set">
                <span>Fixed target size</span>
              </Tooltip>
            }
            style={{ ...FORM_ITEM, flex: 1, minWidth: 160 }}
          >
            <InputNumber
              min={0}
              max={1000}
              value={form.targetSize}
              onChange={(v) => onChange('targetSize', v ?? undefined)}
              placeholder="auto"
              style={{ width: '100%' }}
            />
          </Form.Item>
        </div>

        <Form.Item label="Reconcile interval (ms)" style={FORM_ITEM}>
          <InputNumber
            min={2000}
            max={600_000}
            step={1000}
            value={form.reconcileIntervalMs}
            onChange={(v) => onChange('reconcileIntervalMs', v ?? undefined)}
            style={{ width: 220 }}
          />
        </Form.Item>
      </Form>

      <Alert
        type="info"
        showIcon
        message={
          <span>
            Projected pool size:{' '}
            <strong>
              {projectedSlots !== null
                ? `${projectedSlots} pods (${(projectedSlots * memPer).toLocaleString()} MiB)`
                : `${form.targetSize ?? form.minSize ?? 0} pods (${((form.targetSize ?? form.minSize ?? 0) * memPer).toLocaleString()} MiB)`}
            </strong>
            {form.maxSize ? (
              <Text style={{ marginLeft: 8, fontSize: 12, opacity: 0.7 }}>
                bounded by min={form.minSize ?? 0} / max={form.maxSize}
              </Text>
            ) : null}
          </span>
        }
        style={{ marginTop: 4 }}
      />

      <Divider style={{ margin: '16px 0 12px' }} />

      <Space>
        <Button type="primary" onClick={handleSave} disabled={!dirty} loading={update.isPending}>
          Save
        </Button>
        <Button onClick={handleReset} disabled={!dirty}>
          Discard
        </Button>
      </Space>
    </Card>
  );
};

export default HotPoolSettingsCard;
