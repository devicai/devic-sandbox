import { useState } from 'react';
import {
  Button,
  Card,
  Col,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Row,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCopy, faPen, faPlug, faPlus, faTrash } from '@fortawesome/free-solid-svg-icons';
import type { ColumnsType } from 'antd/es/table';
import {
  useAvailableMcpTools,
  useCreateMcpProfile,
  useDeleteMcpProfile,
  useMcpProfiles,
  useUpdateMcpProfile,
} from '../../hooks/useMcpProfiles';
import type { AvailableMcpTool, McpProfileDto } from '../../api/types';
import McpProfileModal from './McpProfileModal';

const { Title, Text, Paragraph } = Typography;

const DEFAULT_MCP_BASE_URL =
  typeof window !== 'undefined'
    ? `${window.location.origin}/api/v1/mcp`
    : 'http://localhost:3200/api/v1/mcp';
const MCP_BASE_URL = (import.meta.env.VITE_MCP_BASE_URL || DEFAULT_MCP_BASE_URL).replace(/\/$/, '');

function copyToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(
      () => message.success('Copied to clipboard'),
      () => message.error('Failed to copy'),
    );
  }
}

const McpPage: React.FC = () => {
  const { data: tools, isLoading: loadingTools } = useAvailableMcpTools();
  const { data: profiles, isLoading: loadingProfiles } = useMcpProfiles();
  const createProfile = useCreateMcpProfile();
  const updateProfile = useUpdateMcpProfile();
  const deleteProfile = useDeleteMcpProfile();

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<McpProfileDto | null>(null);
  const [selectedTool, setSelectedTool] = useState<AvailableMcpTool | null>(null);

  const columns: ColumnsType<McpProfileDto> = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, row) => (
        <div>
          <div style={{ fontWeight: 600 }}>{name}</div>
          {row.description && <Text type="secondary" style={{ fontSize: 12 }}>{row.description}</Text>}
        </div>
      ),
    },
    {
      title: 'Tools',
      dataIndex: 'allowedTools',
      key: 'tools',
      width: 110,
      render: (v: string[]) => <Tag>{v?.length ?? 0}</Tag>,
    },
    {
      title: 'Mode',
      dataIndex: 'readOnly',
      key: 'readOnly',
      width: 110,
      render: (ro: boolean) => ro ? <Tag color="green">Read-only</Tag> : <Tag color="orange">Read/Write</Tag>,
    },
    {
      title: 'Connection URL',
      key: 'url',
      render: (_: any, row) => {
        const url = `${MCP_BASE_URL}/${row._id}`;
        return (
          <Space>
            <Input value={url} readOnly size="small" style={{ width: 280 }} />
            <Tooltip title="Copy">
              <Button size="small" icon={<FontAwesomeIcon icon={faCopy} />} onClick={() => copyToClipboard(url)} />
            </Tooltip>
          </Space>
        );
      },
    },
    {
      title: '',
      key: 'actions',
      width: 90,
      align: 'right',
      render: (_: any, row) => (
        <Space size={4}>
          <Tooltip title="Edit">
            <Button size="small" icon={<FontAwesomeIcon icon={faPen} />} onClick={() => { setEditing(row); setModalOpen(true); }} />
          </Tooltip>
          <Popconfirm
            title="Delete this profile?"
            onConfirm={() =>
              deleteProfile.mutateAsync(row._id)
                .then(() => message.success('Profile deleted'))
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

  const handleSubmit = async (values: any) => {
    try {
      if (editing) {
        await updateProfile.mutateAsync({ id: editing._id, dto: values });
        message.success('Profile updated');
      } else {
        await createProfile.mutateAsync(values);
        message.success('Profile created');
      }
      setModalOpen(false);
      setEditing(null);
    } catch (e: any) {
      message.error(e?.response?.data?.message ?? e?.message ?? 'Save failed');
    }
  };

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: '0 auto' }}>
      <Title level={3} style={{ marginTop: 0 }}>
        <FontAwesomeIcon icon={faPlug} style={{ marginRight: 8 }} />
        MCP
      </Title>

      <Card title="Connection" style={{ marginBottom: 16 }} styles={{ body: { paddingTop: 12 } }}>
        <Paragraph style={{ marginBottom: 6 }}>
          <Text strong>Base URL</Text> (full-access endpoint)
        </Paragraph>
        <Space style={{ marginBottom: 12 }}>
          <Input value={MCP_BASE_URL} readOnly style={{ width: 460 }} />
          <Button icon={<FontAwesomeIcon icon={faCopy} />} onClick={() => copyToClipboard(MCP_BASE_URL)}>Copy</Button>
        </Space>
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
          Profile-scoped endpoints are exposed at <code>{MCP_BASE_URL}/&lt;profile_id&gt;</code>.
        </Paragraph>
      </Card>

      <Card title="Available tools" style={{ marginBottom: 16 }} styles={{ body: { paddingTop: 12 } }}>
        {loadingTools ? <Spin /> : tools && tools.length > 0 ? (
          <Row gutter={[12, 12]}>
            {tools.map((t) => (
              <Col xs={24} sm={12} lg={8} key={t.name}>
                <Card size="small" hoverable style={{ height: '100%', cursor: 'pointer' }} onClick={() => setSelectedTool(t)}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <code style={{ fontSize: 12, wordBreak: 'break-all' }}>{t.name}</code>
                    {t.writeAccess ? <Tag color="orange" style={{ margin: 0 }}>write</Tag> : <Tag color="blue" style={{ margin: 0 }}>read</Tag>}
                  </div>
                  <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>{t.description}</Text>
                </Card>
              </Col>
            ))}
          </Row>
        ) : <Empty description="No tools available" />}
      </Card>

      <Card
        title="Profiles"
        extra={
          <Button type="primary" icon={<FontAwesomeIcon icon={faPlus} />} onClick={() => { setEditing(null); setModalOpen(true); }}>
            New profile
          </Button>
        }
      >
        <Table
          rowKey="_id"
          size="small"
          loading={loadingProfiles}
          columns={columns}
          dataSource={profiles ?? []}
          pagination={false}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No MCP profiles yet." /> }}
        />
      </Card>

      <Modal
        open={!!selectedTool}
        title={selectedTool ? (
          <Space>
            <code style={{ fontSize: 13 }}>{selectedTool.name}</code>
            {selectedTool.writeAccess ? <Tag color="orange">write</Tag> : <Tag color="blue">read</Tag>}
          </Space>
        ) : null}
        onCancel={() => setSelectedTool(null)}
        footer={null}
        width={680}
      >
        {selectedTool && (
          <>
            <Paragraph type="secondary">{selectedTool.description}</Paragraph>
            <Title level={5} style={{ marginBottom: 8 }}>Parameters</Title>
            {selectedTool.parameters.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No parameters" /> : (
              <Table
                size="small"
                pagination={false}
                rowKey="name"
                dataSource={selectedTool.parameters}
                columns={[
                  { title: 'Name', dataIndex: 'name', width: 170, render: (name: string, row: any) => (
                    <Space size={4}><code style={{ fontSize: 12 }}>{name}</code>{row.required && <Tag color="red">required</Tag>}</Space>
                  ) },
                  { title: 'Type', dataIndex: 'type', width: 90, render: (t: string) => <Tag>{t}</Tag> },
                  { title: 'Description', dataIndex: 'description' },
                ]}
              />
            )}
          </>
        )}
      </Modal>

      <McpProfileModal
        open={modalOpen}
        profile={editing}
        loading={createProfile.isPending || updateProfile.isPending}
        availableTools={tools ?? []}
        onCancel={() => { setModalOpen(false); setEditing(null); }}
        onSubmit={handleSubmit}
      />
    </div>
  );
};

export default McpPage;
