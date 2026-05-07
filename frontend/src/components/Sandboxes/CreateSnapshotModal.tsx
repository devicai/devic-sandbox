import { useEffect } from 'react';
import { Form, Input, Modal, Typography, message } from 'antd';
import { useCreateSnapshot } from '../../hooks/useSnapshots';
import type { SandboxDto } from '../../api/types';

const { Text } = Typography;

interface Props {
  sandbox: SandboxDto | null;
  onClose: () => void;
}

function defaultSnapshotName(sandboxName: string): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+$/, '')
    .replace('T', '-');
  return `${sandboxName}-${stamp}`;
}

const CreateSnapshotModal: React.FC<Props> = ({ sandbox, onClose }) => {
  const [form] = Form.useForm();
  const createSnapshot = useCreateSnapshot();

  useEffect(() => {
    if (sandbox) {
      form.setFieldsValue({
        name: defaultSnapshotName(sandbox.name),
        description: '',
      });
    }
  }, [sandbox, form]);

  const handleSubmit = async () => {
    if (!sandbox) return;
    try {
      const values = await form.validateFields();
      await createSnapshot.mutateAsync({
        sandboxId: sandbox.sandboxId,
        name: values.name?.trim() || undefined,
        description: values.description?.trim() || undefined,
      });
      message.success(`Snapshot "${values.name}" created`);
      form.resetFields();
      onClose();
    } catch (e: any) {
      if (e?.errorFields) return;
      message.error(e?.response?.data?.message ?? e?.message ?? 'Snapshot failed');
    }
  };

  return (
    <Modal
      open={!!sandbox}
      title="Create Snapshot"
      onCancel={() => {
        if (!createSnapshot.isPending) onClose();
      }}
      onOk={handleSubmit}
      okText={createSnapshot.isPending ? 'Creating…' : 'Create'}
      confirmLoading={createSnapshot.isPending}
      maskClosable={!createSnapshot.isPending}
      closable={!createSnapshot.isPending}
      width={480}
    >
      {sandbox && (
        <>
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 16 }}>
            Snapshotting <code>{sandbox.name}</code> ({sandbox.image}). The
            container will be paused briefly while the workspace is archived.
          </Text>
          <Form form={form} layout="vertical" size="small" disabled={createSnapshot.isPending}>
            <Form.Item
              name="name"
              label="Name"
              rules={[{ required: true, message: 'Please give the snapshot a name' }]}
            >
              <Input placeholder="my-snapshot" autoFocus />
            </Form.Item>
            <Form.Item name="description" label="Description (optional)">
              <Input.TextArea rows={2} placeholder="What's in this snapshot?" />
            </Form.Item>
          </Form>
        </>
      )}
    </Modal>
  );
};

export default CreateSnapshotModal;
