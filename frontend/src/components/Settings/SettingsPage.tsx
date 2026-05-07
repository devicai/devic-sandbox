import { useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Input,
  Space,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCircleInfo,
  faCopy,
  faGear,
  faKey,
  faTrash,
  faVial,
  faWandMagicSparkles,
} from '@fortawesome/free-solid-svg-icons';
import { usageApi } from '../../api/client';

const { Title, Text, Paragraph } = Typography;

const STORAGE_KEY = 'devic-sandbox-api-key';

function generateApiKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function copyToClipboard(text: string, label = 'Copied') {
  navigator.clipboard?.writeText(text).then(
    () => message.success(label),
    () => message.error('Failed to copy'),
  );
}

const SettingsPage: React.FC = () => {
  const [savedKey, setSavedKey] = useState(
    () => localStorage.getItem(STORAGE_KEY) ?? '',
  );
  const [draft, setDraft] = useState(savedKey);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    status: number;
    detail?: string;
  } | null>(null);

  const handleSave = () => {
    const next = draft.trim();
    if (next) {
      localStorage.setItem(STORAGE_KEY, next);
      setSavedKey(next);
      message.success('API key saved');
    } else {
      localStorage.removeItem(STORAGE_KEY);
      setSavedKey('');
      message.success('API key cleared');
    }
    setTestResult(null);
  };

  const handleGenerate = () => {
    setDraft(generateApiKey());
    message.info('Generated — review and click Save');
  };

  const handleClear = () => {
    setDraft('');
    localStorage.removeItem(STORAGE_KEY);
    setSavedKey('');
    setTestResult(null);
    message.success('API key cleared');
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await usageApi.get();
      setTestResult({ ok: true, status: res.status });
    } catch (err: any) {
      const status = err?.response?.status ?? 0;
      const detail =
        err?.response?.data?.message ?? err?.message ?? 'Request failed';
      setTestResult({ ok: false, status, detail: String(detail) });
    } finally {
      setTesting(false);
    }
  };

  const dirty = draft.trim() !== savedKey;

  const backendSnippet = useMemo(
    () =>
      [
        '# .env at the backend',
        `SANDBOX_API_KEY=${savedKey || draft.trim() || '<your-key>'}`,
        '',
        '# config.yml',
        'auth:',
        '  enabled: true',
        '  strategy: api-key',
        '  apiKeys:',
        '    - name: web-client',
        '      key: ${SANDBOX_API_KEY}',
      ].join('\n'),
    [savedKey, draft],
  );

  const status = savedKey
    ? { color: 'success' as const, label: 'Configured' }
    : { color: 'default' as const, label: 'Not configured' };

  return (
    <div style={{ padding: 24, maxWidth: 760, margin: '0 auto' }}>
      <Title level={3} style={{ marginTop: 0, marginBottom: 4 }}>
        <FontAwesomeIcon icon={faGear} style={{ marginRight: 10 }} />
        Settings
      </Title>
      <Paragraph type="secondary" style={{ marginBottom: 24 }}>
        Configure how this UI authenticates with the sandbox API.
      </Paragraph>

      <Card
        size="small"
        title={
          <Space size={10}>
            <FontAwesomeIcon icon={faKey} />
            <span>API authentication</span>
          </Space>
        }
        extra={<Badge status={status.color} text={status.label} />}
      >
        <Paragraph type="secondary" style={{ marginTop: 0, fontSize: 13 }}>
          When the backend has <code>auth.enabled: true</code>, every request to{' '}
          <code>/api/v1/*</code> must carry a valid API key. The key is stored
          in your browser's <code>localStorage</code> and automatically sent as{' '}
          <code>Authorization: Bearer &lt;key&gt;</code> on every request.
        </Paragraph>

        <div style={{ marginTop: 16, marginBottom: 8 }}>
          <Text strong style={{ fontSize: 12, letterSpacing: 0.4, opacity: 0.7 }}>
            API KEY
          </Text>
        </div>

        <Space.Compact style={{ width: '100%' }}>
          <Input.Password
            placeholder="Paste an existing key, or click Generate"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPressEnter={handleSave}
            autoComplete="off"
            style={{ fontFamily: 'monospace', fontSize: 13 }}
          />
          <Tooltip title="Copy">
            <Button
              icon={<FontAwesomeIcon icon={faCopy} />}
              disabled={!draft}
              onClick={() => copyToClipboard(draft, 'API key copied')}
            />
          </Tooltip>
        </Space.Compact>

        <Space style={{ marginTop: 12 }} wrap>
          <Button type="primary" onClick={handleSave} disabled={!dirty}>
            Save
          </Button>
          <Button
            icon={<FontAwesomeIcon icon={faWandMagicSparkles} />}
            onClick={handleGenerate}
          >
            Generate
          </Button>
          <Button
            icon={<FontAwesomeIcon icon={faVial} />}
            onClick={handleTest}
            loading={testing}
            disabled={!savedKey}
          >
            Test connection
          </Button>
          <Button
            danger
            icon={<FontAwesomeIcon icon={faTrash} />}
            onClick={handleClear}
            disabled={!savedKey && !draft}
          >
            Clear
          </Button>
        </Space>

        {testResult && (
          <div style={{ marginTop: 16 }}>
            {testResult.ok ? (
              <Alert
                type="success"
                showIcon
                message={`API reachable (HTTP ${testResult.status})`}
                description="The key is accepted, or the backend has auth disabled."
              />
            ) : (
              <Alert
                type="error"
                showIcon
                message={`Request failed (HTTP ${testResult.status || 'network error'})`}
                description={testResult.detail ?? 'Unknown error'}
              />
            )}
          </div>
        )}

        <Alert
          type="info"
          showIcon
          icon={<FontAwesomeIcon icon={faCircleInfo} />}
          style={{ marginTop: 20 }}
          message="Mirror this key on the backend"
          description={
            <div>
              <Paragraph style={{ marginBottom: 8, fontSize: 13 }}>
                The key lives only in your browser. To enforce it on the API,
                add it to the backend config and enable auth:
              </Paragraph>
              <div style={{ position: 'relative' }}>
                <pre
                  style={{
                    background: 'rgba(0,0,0,0.35)',
                    padding: 12,
                    borderRadius: 6,
                    fontSize: 12,
                    margin: 0,
                    overflow: 'auto',
                  }}
                >
                  {backendSnippet}
                </pre>
                <Button
                  size="small"
                  type="text"
                  icon={<FontAwesomeIcon icon={faCopy} />}
                  style={{ position: 'absolute', top: 6, right: 6 }}
                  onClick={() =>
                    copyToClipboard(backendSnippet, 'Snippet copied')
                  }
                />
              </div>
            </div>
          }
        />
      </Card>
    </div>
  );
};

export default SettingsPage;
