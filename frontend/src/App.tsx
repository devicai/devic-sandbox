import { Routes, Route, Navigate } from 'react-router';
import { ConfigProvider, theme } from 'antd';
import AppLayout from './components/Layout/AppLayout';
import SandboxesPage from './components/Sandboxes/SandboxesPage';
import ProfilesPage from './components/Profiles/ProfilesPage';
import SnapshotsPage from './components/Snapshots/SnapshotsPage';
import McpPage from './components/Mcp/McpPage';
import ApiPage from './components/Api/ApiPage';
import SettingsPage from './components/Settings/SettingsPage';

const THEME_TOKENS = {
  colorPrimary: '#4661B1',
  colorInfo: '#4661B1',
  colorText: '#b3b3b3',
  borderRadius: 6,
};

const App: React.FC = () => {
  const isDark = true;

  return (
    <ConfigProvider
      theme={{
        algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: THEME_TOKENS,
        components: {
          Card: { bodyPadding: 10 },
          Button: {
            colorPrimaryBorderHover: THEME_TOKENS.colorPrimary,
            defaultHoverBorderColor: THEME_TOKENS.colorPrimary,
          },
        },
      }}
    >
      <div
        data-theme={isDark ? 'dark' : 'light'}
        style={
          {
            '--theme-primary-color': THEME_TOKENS.colorPrimary,
            '--theme-info-color': THEME_TOKENS.colorInfo,
            '--theme-text-color': THEME_TOKENS.colorText,
            '--theme-info-shadow': 'rgba(70, 97, 177, 0.2)',
            height: '100%',
          } as React.CSSProperties
        }
      >
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/sandboxes" element={<SandboxesPage />} />
            <Route path="/snapshots" element={<SnapshotsPage />} />
            <Route path="/profiles" element={<ProfilesPage />} />
            <Route path="/mcp" element={<McpPage />} />
            <Route path="/api" element={<ApiPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/sandboxes" replace />} />
          </Route>
        </Routes>
      </div>
    </ConfigProvider>
  );
};

export default App;
