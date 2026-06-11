import { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import {
  faTerminal,
  faCubes,
  faPlug,
  faCode,
  faCamera,
} from '@fortawesome/free-solid-svg-icons';

export interface ModuleSubSection {
  key: string;
  label: string;
  icon: IconDefinition;
  path: string;
  disabled?: boolean;
}

export interface ModuleConfig {
  name: string;
  icon: IconDefinition;
  basePath: string;
  sections: ModuleSubSection[];
}

export const MODULE_CONFIG: ModuleConfig = {
  name: 'Operator',
  icon: faTerminal,
  basePath: '/sandboxes',
  sections: [
    {
      key: 'sandboxes',
      label: 'Sandboxes',
      icon: faTerminal,
      path: '/sandboxes',
    },
    {
      key: 'snapshots',
      label: 'Snapshots',
      icon: faCamera,
      path: '/snapshots',
    },
    {
      key: 'profiles',
      label: 'Profiles',
      icon: faCubes,
      path: '/profiles',
    },
    {
      key: 'mcp',
      label: 'MCP',
      icon: faPlug,
      path: '/mcp',
    },
    {
      key: 'api',
      label: 'API',
      icon: faCode,
      path: '/api',
    },
  ],
};
