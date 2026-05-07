import { useMemo, useState } from 'react';
import {
  Button,
  Card,
  Col,
  Form,
  Input,
  Menu,
  Row,
  Space,
  Tag,
  Typography,
  message,
} from 'antd';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCode, faCopy, faPlay } from '@fortawesome/free-solid-svg-icons';
import axios from 'axios';
import { API_CATEGORIES, API_ENDPOINTS, type EndpointSpec } from './endpoints';

const { Title, Text } = Typography;
const { TextArea } = Input;

const DEFAULT_API_BASE =
  typeof window !== 'undefined' ? `${window.location.origin}/api/v1` : '/api/v1';
const API_BASE = (import.meta.env.VITE_API_URL || DEFAULT_API_BASE).replace(/\/$/, '');

const METHOD_COLORS: Record<string, string> = {
  GET: 'blue',
  POST: 'green',
  PATCH: 'orange',
  DELETE: 'red',
};

function copyToClipboard(text: string) {
  navigator.clipboard?.writeText(text).then(
    () => message.success('Copied'),
    () => message.error('Failed to copy'),
  );
}

function buildUrl(endpoint: EndpointSpec, pathValues: Record<string, string>, queryValues: Record<string, unknown>): { path: string; url: string } {
  let resolvedPath = endpoint.path;
  for (const p of endpoint.pathParams ?? []) {
    resolvedPath = resolvedPath.replace(`:${p.name}`, encodeURIComponent(String(pathValues[p.name] ?? '')));
  }
  const qs = new URLSearchParams();
  for (const q of endpoint.queryParams ?? []) {
    const raw = queryValues[q.name];
    if (raw === undefined || raw === null || raw === '') continue;
    qs.append(q.name, String(raw));
  }
  const query = qs.toString();
  const fullPath = query ? `${resolvedPath}?${query}` : resolvedPath;
  return { path: fullPath, url: `${API_BASE}${fullPath}` };
}

const ApiPage: React.FC = () => {
  const [selected, setSelected] = useState(API_ENDPOINTS[0]?.id ?? '');
  const [pathValues, setPathValues] = useState<Record<string, string>>({});
  const [queryValues, setQueryValues] = useState<Record<string, unknown>>({});
  const [bodyText, setBodyText] = useState('');
  const [response, setResponse] = useState<{ status: number; data: string; time: number } | null>(null);
  const [loading, setLoading] = useState(false);

  const endpoint = useMemo(() => API_ENDPOINTS.find((e) => e.id === selected), [selected]);

  const menuItems = API_CATEGORIES.map((cat) => ({
    key: cat,
    label: cat,
    type: 'group' as const,
    children: API_ENDPOINTS.filter((e) => e.category === cat).map((e) => ({
      key: e.id,
      label: (
        <Space size={6}>
          <Tag color={METHOD_COLORS[e.method]} style={{ margin: 0, fontSize: 10, minWidth: 45, textAlign: 'center' }}>{e.method}</Tag>
          <span style={{ fontSize: 12 }}>{e.summary}</span>
        </Space>
      ),
    })),
  }));

  const handleSelect = (id: string) => {
    setSelected(id);
    setPathValues({});
    setQueryValues({});
    setResponse(null);
    const ep = API_ENDPOINTS.find((e) => e.id === id);
    setBodyText(ep?.body?.sample ?? '');
  };

  const handleRun = async () => {
    if (!endpoint) return;
    setLoading(true);
    const start = Date.now();
    try {
      const { url } = buildUrl(endpoint, pathValues, queryValues);
      const apiKey = localStorage.getItem('devic-sandbox-api-key');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

      const res = await axios({
        method: endpoint.method.toLowerCase() as any,
        url,
        data: ['POST', 'PATCH'].includes(endpoint.method) && bodyText ? JSON.parse(bodyText) : undefined,
        headers,
        validateStatus: () => true,
      });
      setResponse({
        status: res.status,
        data: JSON.stringify(res.data, null, 2),
        time: Date.now() - start,
      });
    } catch (e: any) {
      setResponse({ status: 0, data: e.message, time: Date.now() - start });
    } finally {
      setLoading(false);
    }
  };

  const curlSnippet = useMemo(() => {
    if (!endpoint) return '';
    const { url } = buildUrl(endpoint, pathValues, queryValues);
    let cmd = `curl -X ${endpoint.method} '${url}'`;
    const apiKey = localStorage.getItem('devic-sandbox-api-key');
    if (apiKey) cmd += ` \\\n  -H 'Authorization: Bearer ${apiKey}'`;
    if (['POST', 'PATCH'].includes(endpoint.method) && bodyText) {
      cmd += ` \\\n  -H 'Content-Type: application/json'`;
      cmd += ` \\\n  -d '${bodyText.replace(/\n/g, '')}'`;
    }
    return cmd;
  }, [endpoint, pathValues, queryValues, bodyText]);

  return (
    <div style={{ padding: 24, maxWidth: 1400, margin: '0 auto' }}>
      <Title level={3} style={{ marginTop: 0 }}>
        <FontAwesomeIcon icon={faCode} style={{ marginRight: 8 }} />
        API
      </Title>
      <Row gutter={16}>
        <Col span={7}>
          <Card size="small" styles={{ body: { padding: 0 } }}>
            <Menu
              mode="inline"
              selectedKeys={[selected]}
              items={menuItems}
              onClick={({ key }) => handleSelect(key)}
              style={{ border: 'none', backgroundColor: 'transparent' }}
            />
          </Card>
        </Col>
        <Col span={17}>
          {endpoint && (
            <Card size="small">
              <Space style={{ marginBottom: 12 }}>
                <Tag color={METHOD_COLORS[endpoint.method]} style={{ fontSize: 13 }}>{endpoint.method}</Tag>
                <code style={{ fontSize: 13 }}>{endpoint.path}</code>
              </Space>
              <div style={{ marginBottom: 8 }}>
                <Text type="secondary">{endpoint.summary}</Text>
              </div>

              {(endpoint.pathParams ?? []).map((p) => (
                <Form.Item key={p.name} label={p.name} style={{ marginBottom: 8 }}>
                  <Input
                    size="small"
                    placeholder={p.description}
                    value={pathValues[p.name] ?? ''}
                    onChange={(e) => setPathValues({ ...pathValues, [p.name]: e.target.value })}
                  />
                </Form.Item>
              ))}

              {(endpoint.queryParams ?? []).map((q) => (
                <Form.Item key={q.name} label={q.name} style={{ marginBottom: 8 }}>
                  <Input
                    size="small"
                    placeholder={q.description}
                    value={String(queryValues[q.name] ?? '')}
                    onChange={(e) => setQueryValues({ ...queryValues, [q.name]: e.target.value })}
                  />
                </Form.Item>
              ))}

              {endpoint.body && (
                <Form.Item label="Body" style={{ marginBottom: 8 }}>
                  <TextArea
                    rows={6}
                    value={bodyText}
                    onChange={(e) => setBodyText(e.target.value)}
                    style={{ fontFamily: 'monospace', fontSize: 12 }}
                  />
                </Form.Item>
              )}

              <Space style={{ marginBottom: 12 }}>
                <Button type="primary" icon={<FontAwesomeIcon icon={faPlay} />} onClick={handleRun} loading={loading}>
                  Run
                </Button>
                <Button icon={<FontAwesomeIcon icon={faCopy} />} onClick={() => copyToClipboard(curlSnippet)}>
                  Copy cURL
                </Button>
              </Space>

              {response && (
                <div>
                  <Space style={{ marginBottom: 8 }}>
                    <Tag color={response.status >= 200 && response.status < 300 ? 'green' : 'red'}>
                      {response.status}
                    </Tag>
                    <Text type="secondary">{response.time}ms</Text>
                  </Space>
                  <pre style={{
                    background: 'rgba(255,255,255,0.04)',
                    padding: 12,
                    borderRadius: 6,
                    fontSize: 12,
                    overflow: 'auto',
                    maxHeight: 400,
                  }}>
                    {response.data}
                  </pre>
                </div>
              )}
            </Card>
          )}
        </Col>
      </Row>
    </div>
  );
};

export default ApiPage;
