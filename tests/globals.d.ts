// Augment Window so page.evaluate() callbacks can reference window.formatpad
interface Window {
  formatpad: {
    platform: string;
    dropFile: (file: File) => void;
    autoSaveRecovery: (filePath: string | null, content: string) => Promise<void>;
    clearRecovery: (filePath: string | null) => Promise<void>;
    saveFile: (filePath: string, content: string) => Promise<unknown>;
    saveFileAs: (content: string) => Promise<unknown>;
    readFile: (filePath: string) => Promise<{ error?: string; content?: string }>;
    getApprovedWorkspace: () => Promise<string | null>;
    openFileDialog: () => Promise<unknown>;
    getSystemTheme: () => Promise<string>;
    setTitle: (title: string) => void;
    [key: string]: unknown;
  };
}
