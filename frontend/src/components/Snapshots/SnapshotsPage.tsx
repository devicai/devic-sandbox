import { useState } from 'react';
import {
  Button,
  Empty,
  Popconfirm,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
  Modal,
  Form,
  InputNumber,
} from 'antd';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCamera,
  faCodeBranch,
  faPlay,
  faTrash,
} from '@fortawesome/free-solid-svg-icons';
import type { ColumnsType } from 'antd/es/table';
import { useSnapshots, useRestoreSnapshot, useDeleteSnapshot } from '../../hooks/useSnapshots';
import { useUsage } from '../../hooks/useUsage';
import type { SnapshotDto } from '../../api/types';
import UsagePanel from '../Usage/UsagePanel';

const { Title, Text } = Typography;

const STATUS_COLORS: Record<string, string> = {
  ready: 'green',
  creating: 'blue',
  restoring: 'orange',
  failed: 'red',
};

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

const SnapshotsPage: React.FC = () => {
  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<'restore' | 'fork'>('restore');
  const [selectedSnapshot, setSelectedSnapshot] = useState<SnapshotDto | null>(null);
  const [form] = Form.useForm();

  const { data, isLoading } = useSnapshots();
  const { data: usage, isLoading: usageLoading } = useUsage();
  const restoreSnapshot = useRestoreSnapshot();
  const deleteSnapshot = useDeleteSnapshot();

  const snapshots = data?.data ?? [];
  const totalDiskBytes = usage?.disk.usedBytes ?? 0;
  const diskLimitBytes = usage?.disk.limitBytes ?? 0;
  const dbReportedBytes = snapshots
    .filter((s) => s.status === 'ready')
    .reduce((acc, s) => acc + (s.sizeBytes ?? 0), 0);

  const openModal = (snapshot: SnapshotDto, mode: 'restore' | 'fork') => {
    setSelectedSnapshot(snapshot);
    setModalMode(mode);
    form.setFieldsValue({
      ttlSeconds: 1800,
      cpus: snapshot.cpus,
      memoryMib: snapshot.memoryMib,
    });
    setModalOpen(true);
  };

  const handleSubmit = async () => {
    if (!selectedSnapshot) return;
    try {
      const values = await form.validateFields();
      await restoreSnapshot.mutateAsync({
        id: selectedSnapshot.snapshotId,
        dto: { ...values, linked: modalMode === 'restore' },
      });
      message.success(
        modalMode === 'restore'
          ? 'Sandbox restored (linked to snapshot)'
          : 'Independent sandbox created from snapshot',
      );
      setModalOpen(false);
      setSelectedSnapshot(null);
    } catch (e: any) {
      if (!e?.errorFields) {
        message.error(e?.response?.data?.message ?? e?.message ?? 'Failed');
      }
    }
  };

  const columns: ColumnsType<SnapshotDto> = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, row) => (
        <div>
          <code style={{ fontSize: 12 }}>{name}</code>
          {row.description && (
            <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{row.description}</div>
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
      title: 'Source Sandbox',
      dataIndex: 'sandboxId',
      key: 'sandboxId',
      width: 150,
      render: (id: string) => <code style={{ fontSize: 11 }}>{id}</code>,
    },
    {
      title: 'Image',
      dataIndex: 'image',
      key: 'image',
      width: 120,
      render: (img: string) => <code style={{ fontSize: 11 }}>{img}</code>,
    },
    {
      title: 'Size',
      dataIndex: 'sizeBytes',
      key: 'size',
      width: 90,
      render: (bytes: number) => <span style={{ fontSize: 11 }}>{formatSize(bytes)}</span>,
    },
    {
      title: 'Quota share',
      key: 'diskShare',
      width: 100,
      align: 'right',
      render: (_: any, row) => {
        if (row.status !== 'ready' || diskLimitBytes <= 0) {
          return <span style={{ fontSize: 11, opacity: 0.5 }}>-</span>;
        }
        const pct = ((row.sizeBytes ?? 0) / diskLimitBytes) * 100;
        const display = pct < 0.01 ? '<0.01%' : `${pct.toFixed(2)}%`;
        return (
          <Tooltip title={`${formatSize(row.sizeBytes ?? 0)} of ${formatSize(diskLimitBytes)} disk quota`}>
            <span style={{ fontSize: 11 }}>{display}</span>
          </Tooltip>
        );
      },
    },
    {
      title: 'Created',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 160,
      render: (d: string) => <span style={{ fontSize: 11 }}>{formatDate(d)}</span>,
    },
    {
      title: '',
      key: 'actions',
      width: 130,
      align: 'right',
      render: (_: any, row) => (
        <Space size={4}>
          {row.status === 'ready' && (
            <>
              <Tooltip title="Restore (linked)">
                <Button
                  size="small"
                  icon={<FontAwesomeIcon icon={faPlay} />}
                  onClick={() => openModal(row, 'restore')}
                />
              </Tooltip>
              <Tooltip title="Fork (independent)">
                <Button
                  size="small"
                  icon={<FontAwesomeIcon icon={faCodeBranch} />}
                  onClick={() => openModal(row, 'fork')}
                />
              </Tooltip>
            </>
          )}
          <Popconfirm
            title="Delete this snapshot?"
            onConfirm={() =>
              deleteSnapshot
                .mutateAsync(row.snapshotId)
                .then(() => message.success('Snapshot deleted'))
                .catch((e) => message.error(e?.message ?? 'Delete failed'))
            }
          >
            <Tooltip title="Delete">
              <Button size="small" danger icon={<FontAwesomeIcon icon={faTrash} />} />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const isRestore = modalMode === 'restore';

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={3} style={{ marginTop: 0, marginBottom: 0 }}>
          <FontAwesomeIcon icon={faCamera} style={{ marginRight: 8 }} />
          Snapshots
        </Title>
      </div>

      <UsagePanel usage={usage} loading={usageLoading} />

      <Table
        rowKey="_id"
        size="small"
        loading={isLoading}
        columns={columns}
        dataSource={snapshots}
        pagination={false}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="No snapshots yet. Create one from a running sandbox."
            />
          ),
        }}
        summary={() =>
          snapshots.some((s) => s.status === 'ready') ? (
            <Table.Summary fixed>
              <Table.Summary.Row>
                <Table.Summary.Cell index={0} colSpan={4}>
                  <Text strong style={{ fontSize: 12 }}>
                    Total ({snapshots.filter((s) => s.status === 'ready').length} ready)
                  </Text>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={4}>
                  <Tooltip
                    title={
                      Math.abs(dbReportedBytes - totalDiskBytes) > 1024
                        ? `DB reports ${formatSize(dbReportedBytes)} but ${formatSize(totalDiskBytes)} is actually on disk. The drift usually comes from snapshots whose file is missing or from pending persists.`
                        : 'Sum of sizeBytes recorded on each snapshot document'
                    }
                  >
                    <span style={{ fontSize: 11 }}>{formatSize(dbReportedBytes)}</span>
                  </Tooltip>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={5}>
                  <Tooltip title="Real bytes measured on the host by /usage">
                    <span style={{ fontSize: 11, fontWeight: 600 }}>
                      {formatSize(totalDiskBytes)} on disk
                    </span>
                  </Tooltip>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={6} colSpan={2} />
              </Table.Summary.Row>
            </Table.Summary>
          ) : null
        }
      />

      <Modal
        title={isRestore ? 'Restore Snapshot (linked)' : 'Fork Snapshot (independent)'}
        open={modalOpen}
        onCancel={() => { setModalOpen(false); setSelectedSnapshot(null); }}
        onOk={handleSubmit}
        confirmLoading={restoreSnapshot.isPending}
        okText={isRestore ? 'Restore' : 'Fork'}
        width={420}
      >
        {selectedSnapshot && (
          <div style={{ marginBottom: 16 }}>
            <Text style={{ fontSize: 12, color: '#888' }}>
              From <code>{selectedSnapshot.name}</code> ({selectedSnapshot.image})
            </Text>
            <div style={{ marginTop: 8 }}>
              <Tag color={isRestore ? 'blue' : 'green'} style={{ fontSize: 11 }}>
                {isRestore
                  ? 'Changes will auto-save to snapshot on stop'
                  : 'Fully independent — snapshot stays unchanged'}
              </Tag>
            </div>
          </div>
        )}
        <Form form={form} layout="vertical" size="small">
          <Form.Item label="TTL (seconds)" name="ttlSeconds">
            <InputNumber min={60} max={7200} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="vCPUs" name="cpus">
            <InputNumber min={1} max={8} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="Memory (MiB)" name="memoryMib">
            <InputNumber min={256} max={8192} step={256} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default SnapshotsPage;
