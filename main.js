const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

function getClaudeConfigPath() {
  const homeDir = os.homedir();

  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'claude');
  } else {
    return path.join(homeDir, '.claude');
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1a1a1a'
  });

  win.loadFile('index.html');
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// IPC handlers for reading session data
ipcMain.handle('get-sessions', async () => {
  try {
    const configPath = getClaudeConfigPath();
    const historyPath = path.join(configPath, 'history.jsonl');
    const projectsPath = path.join(configPath, 'projects');

    if (!fs.existsSync(historyPath)) {
      return { error: 'History file not found at: ' + historyPath };
    }

    // Read history.jsonl to get all user prompts
    const historyContent = fs.readFileSync(historyPath, 'utf-8');
    const historyLines = historyContent.trim().split('\n').filter(line => line.trim());

    // Parse history entries
    const historyEntries = historyLines.map(line => {
      try {
        return JSON.parse(line);
      } catch (e) {
        return null;
      }
    }).filter(entry => entry !== null);

    // Group by project and timestamp to identify sessions
    const sessionMap = new Map();

    // Read all session files from projects directory
    if (fs.existsSync(projectsPath)) {
      const projectDirs = fs.readdirSync(projectsPath);

      for (const projectDir of projectDirs) {
        const projectPath = path.join(projectsPath, projectDir);
        const stat = fs.statSync(projectPath);

        if (stat.isDirectory()) {
          const sessionFiles = fs.readdirSync(projectPath).filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'));

          for (const sessionFile of sessionFiles) {
            const sessionPath = path.join(projectPath, sessionFile);
            const sessionId = sessionFile.replace('.jsonl', '');

            try {
              const sessionContent = fs.readFileSync(sessionPath, 'utf-8');
              const lines = sessionContent.trim().split('\n').filter(line => line.trim());

              if (lines.length > 0) {
                const messages = lines.map(line => {
                  try {
                    return JSON.parse(line);
                  } catch (e) {
                    return null;
                  }
                }).filter(msg => msg !== null);

                // Find first user message
                const firstUserMessage = messages.find(msg => msg.type === 'user' && msg.message);

                if (firstUserMessage) {
                  const projectName = projectDir.replace(/-/g, '/').substring(1); // Remove leading dash and convert dashes to slashes

                  // Extract content - it might be a string or an array
                  let content = '';
                  if (typeof firstUserMessage.message.content === 'string') {
                    content = firstUserMessage.message.content;
                  } else if (Array.isArray(firstUserMessage.message.content)) {
                    content = firstUserMessage.message.content
                      .filter(block => block.type === 'text')
                      .map(block => block.text)
                      .join(' ');
                  }

                  sessionMap.set(sessionId, {
                    id: sessionId,
                    timestamp: new Date(firstUserMessage.timestamp).getTime(),
                    display: content.substring(0, 100),
                    project: projectName,
                    projectDir: projectDir,
                    messageCount: messages.filter(m => m.type === 'user' || m.type === 'assistant').length
                  });
                }
              }
            } catch (e) {
              console.error('Error reading session file:', sessionPath, e);
            }
          }
        }
      }
    }

    // Convert to array and sort by timestamp (newest first)
    const sessions = Array.from(sessionMap.values()).sort((a, b) => b.timestamp - a.timestamp);

    return { sessions };
  } catch (error) {
    return { error: error.message };
  }
});

ipcMain.handle('get-session-details', async (event, sessionId, projectDir) => {
  try {
    const configPath = getClaudeConfigPath();
    const projectsPath = path.join(configPath, 'projects');
    const sessionPath = path.join(projectsPath, projectDir, `${sessionId}.jsonl`);

    if (!fs.existsSync(sessionPath)) {
      return { error: 'Session file not found' };
    }

    const sessionContent = fs.readFileSync(sessionPath, 'utf-8');
    const lines = sessionContent.trim().split('\n').filter(line => line.trim());

    const messages = lines.map(line => {
      try {
        return JSON.parse(line);
      } catch (e) {
        return null;
      }
    }).filter(msg => msg !== null);

    // Filter and format messages for display
    const formattedMessages = messages
      .filter(msg => (msg.type === 'user' || msg.type === 'assistant') && msg.message)
      .map(msg => {
        if (msg.type === 'user') {
          // Extract content - it might be a string or an array
          let content = '';
          let toolResults = [];
          if (typeof msg.message.content === 'string') {
            content = msg.message.content;
          } else if (Array.isArray(msg.message.content)) {
            content = msg.message.content
              .filter(block => block.type === 'text')
              .map(block => block.text)
              .join('\n\n');
            toolResults = msg.message.content
              .filter(block => block.type === 'tool_result')
              .map(block => ({
                tool_use_id: block.tool_use_id,
                content: typeof block.content === 'string' ? block.content :
                  Array.isArray(block.content) ? block.content
                    .filter(c => c.type === 'text')
                    .map(c => c.text)
                    .join('\n') : '',
                is_error: block.is_error || false
              }));
          }

          // Skip messages that are only tool results (show them inline with assistant)
          if (!content && toolResults.length > 0) {
            return {
              role: 'tool_result',
              toolResults: toolResults,
              timestamp: msg.timestamp
            };
          }

          return {
            role: 'user',
            content: content,
            timestamp: msg.timestamp
          };
        } else if (msg.type === 'assistant') {
          // Extract all content types from assistant messages
          let content = '';
          let thinking = '';
          let toolUses = [];

          if (Array.isArray(msg.message.content)) {
            content = msg.message.content
              .filter(block => block.type === 'text')
              .map(block => block.text)
              .join('\n\n');
            thinking = msg.message.content
              .filter(block => block.type === 'thinking')
              .map(block => block.thinking || block.text || '')
              .join('\n\n');
            toolUses = msg.message.content
              .filter(block => block.type === 'tool_use')
              .map(block => ({
                id: block.id,
                name: block.name,
                input: block.input || {}
              }));
          } else if (typeof msg.message.content === 'string') {
            content = msg.message.content;
          }

          return {
            role: 'assistant',
            content: content,
            thinking: thinking,
            timestamp: msg.timestamp,
            toolUses: toolUses
          };
        }
        return null;
      })
      .filter(msg => msg !== null && (msg.content || msg.toolUses?.length > 0 || msg.toolResults?.length > 0));

    return { messages: formattedMessages };
  } catch (error) {
    return { error: error.message };
  }
});
