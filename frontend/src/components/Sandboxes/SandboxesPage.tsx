import { useState } from 'react';
import {
  Button,
  Empty,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCamera,
  faPlus,
  faStop,
  faTerminal,
  faTrash,
} from '@fortawesome/free-solid-svg-icons';
import type { ColumnsType } from 'antd/es/table';
import { useSandboxes, useStopSandbox, useDestroySandbox } from '../../hooks/useSandboxes';
import { useUsage } from '../../hooks/useUsage';
import type { SandboxDto } from '../../api/types';
import CreateSandboxModal from './CreateSandboxModal';
import CreateSnapshotModal from './CreateSnapshotModal';
import TerminalDrawer from './TerminalDrawer';
import UsagePanel from '../Usage/UsagePanel';

const { Title } = Typography;

const STATUS_COLORS: Record<string, string> = {
  running: 'green',
  creating: 'blue',
  pending: 'default',
  stopping: 'orange',
  stopped: 'default',
  expired: 'red',
  failed: 'red',
};

function formatRemaining(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `${min}m ${sec}s`;
}

const SandboxesPage: React.FC = () => {
  const [statusFilter, setStatusFilter] = useState<string | undefined>();
  const [createOpen, setCreateOpen] = useState(false);
  const [terminalSandbox, setTerminalSandbox] = useState<SandboxDto | null>(null);
  const [snapshotSandbox, setSnapshotSandbox] = useState<SandboxDto | null>(null);
  const [stoppingIds, setStoppingIds] = useState<Set<string>>(new Set());
  const [destroyingIds, setDestroyingIds] = useState<Set<string>>(new Set());

  const { data, isLoading } = useSandboxes({ status: statusFilter });
  const { data: usage, isLoading: usageLoading } = useUsage();
  const stopSandbox = useStopSandbox();
  const destroySandbox = useDestroySandbox();

  const handleStop = async (id: string) => {
    setStoppingIds((prev) => new Set(prev).add(id));
    try {
      await stopSandbox.mutateAsync(id);
      message.success('Sandbox stopped');
    } catch (e: any) {
      message.error(e?.message ?? 'Stop failed');
    } finally {
      setStoppingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const handleDestroy = async (id: string) => {
    setDestroyingIds((prev) => new Set(prev).add(id));
    try {
      await destroySandbox.mutateAsync(id);
      message.success('Sandbox destroyed');
    } catch (e: any) {
      message.error(e?.message ?? 'Destroy failed');
    } finally {
      setDestroyingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const sandboxes = data?.data ?? [];
  const totalMemoryMib = usage?.memory.usedMib ?? 0;

  const columns: ColumnsType<SandboxDto> = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, row) => (
        <div>
          <code style={{ fontSize: 12 }}>{name}</code>
          {row.bindingId && (
            <div><Tag style={{ fontSize: 10, marginTop: 2 }}>binding: {row.bindingId}</Tag></div>
          )}
        </div>
      ),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (s: string) => <Tag color={STATUS_COLORS[s] ?? 'default'}>{s}</Tag>,
    },
    {
      title: 'Image',
      dataIndex: 'image',
      key: 'image',
      width: 120,
      render: (img: string) => <code style={{ fontSize: 11 }}>{img}</code>,
    },
    {
      title: 'Resources',
      key: 'resources',
      width: 120,
      render: (_: any, row) => (
        <span style={{ fontSize: 11 }}>
          {row.cpus} vCPU / {row.memoryMib} MiB
        </span>
      ),
    },
    {
      title: 'RAM share',
      key: 'memoryShare',
      width: 110,
      align: 'right',
      render: (_: any, row) => {
        if (totalMemoryMib <= 0) return <span style={{ fontSize: 11, opacity: 0.5 }}>-</span>;
        const pct = (row.memoryMib / totalMemoryMib) * 100;
        return (
          <Tooltip title={`${row.memoryMib} MiB of ${totalMemoryMib} MiB in use`}>
            <span style={{ fontSize: 11 }}>{pct.toFixed(1)}%</span>
          </Tooltip>
        );
      },
    },
    {
      title: 'TTL',
      key: 'ttl',
      width: 100,
      render: (_: any, row) => {
        if (row.status !== 'running') return '-';
        const remaining = formatRemaining(row.expiresAt);
        const ms = new Date(row.expiresAt).getTime() - Date.now();
        const color = ms > 600000 ? 'green' : ms > 300000 ? 'orange' : 'red';
        return <Tag color={color}>{remaining}</Tag>;
      },
    },
    {
      title: 'Commands',
      dataIndex: 'commandCount',
      key: 'commands',
      width: 90,
      align: 'center',
    },
    {
      title: '',
      key: 'actions',
      width: 120,
      align: 'right',
      render: (_: any, row) => (
        <Space size={4}>
          {row.status === 'running' && (
            <>
              <Tooltip title="Terminal">
                <Button
                  size="small"
                  icon={<FontAwesomeIcon icon={faTerminal} />}
                  onClick={() => setTerminalSandbox(row)}
                />
              </Tooltip>
              <Tooltip title="Snapshot">
                <Button
                  size="small"
                  icon={<FontAwesomeIcon icon={faCamera} />}
                  onClick={() => setSnapshotSandbox(row)}
                />
              </Tooltip>
              <Tooltip title={stoppingIds.has(row.sandboxId) ? 'Stopping…' : 'Stop'}>
                <Button
                  size="small"
                  icon={<FontAwesomeIcon icon={faStop} />}
                  loading={stoppingIds.has(row.sandboxId)}
                  disabled={stoppingIds.has(row.sandboxId)}
                  onClick={() => handleStop(row.sandboxId)}
                />
              </Tooltip>
            </>
          )}
          <Popconfirm
            title="Destroy this sandbox?"
            onConfirm={() => handleDestroy(row.sandboxId)}
            disabled={destroyingIds.has(row.sandboxId)}
          >
            <Tooltip title={destroyingIds.has(row.sandboxId) ? 'Destroying…' : 'Destroy'}>
              <Button
                size="small"
                danger
                icon={<FontAwesomeIcon icon={faTrash} />}
                loading={destroyingIds.has(row.sandboxId)}
                disabled={destroyingIds.has(row.sandboxId)}
              />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={3} style={{ marginTop: 0, marginBottom: 0 }}>
          <FontAwesomeIcon icon={faTerminal} style={{ marginRight: 8 }} />
          Sandboxes
        </Title>
        <Space>
          <Select
            placeholder="Filter status"
            allowClear
            style={{ width: 140 }}
            value={statusFilter}
            onChange={setStatusFilter}
            options={[
              { label: 'Running', value: 'running' },
              { label: 'Stopped', value: 'stopped' },
              { label: 'Expired', value: 'expired' },
              { label: 'Failed', value: 'failed' },
            ]}
          />
          <Button
            type="primary"
            icon={<FontAwesomeIcon icon={faPlus} />}
            onClick={() => setCreateOpen(true)}
          >
            New Sandbox
          </Button>
        </Space>
      </div>

      <UsagePanel usage={usage} loading={usageLoading} />

      <Table
        rowKey="_id"
        size="small"
        loading={isLoading}
        columns={columns}
        dataSource={sandboxes}
        pagination={false}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="No sandboxes yet. Create one to get started."
            />
          ),
        }}
      />

      <CreateSandboxModal
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
      />

      <TerminalDrawer
        sandbox={terminalSandbox}
        onClose={() => setTerminalSandbox(null)}
      />

      <CreateSnapshotModal
        sandbox={snapshotSandbox}
        onClose={() => setSnapshotSandbox(null)}
      />
    </div>
  );
};

export default SandboxesPage;
