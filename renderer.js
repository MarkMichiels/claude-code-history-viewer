const { ipcRenderer } = require('electron');
const { marked } = require('marked');
const hljs = require('highlight.js');

let currentSessions = [];
let currentSessionId = null;
let currentProjectDir = null;
let isLiveMode = false;
let toolResultMap = new Map();

// Configure marked for syntax highlighting
marked.setOptions({
  highlight: function(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang }).value;
      } catch (err) {
        console.error('Highlight error:', err);
      }
    }
    return hljs.highlightAuto(code).value;
  },
  breaks: true,
  gfm: true
});

// Format timestamp
function formatTimestamp(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days === 0) {
    return 'Today, ' + date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  } else if (days === 1) {
    return 'Yesterday, ' + date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  } else if (days < 7) {
    return date.toLocaleDateString('en-US', { weekday: 'long', hour: 'numeric', minute: '2-digit' });
  } else {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
}

// Format timestamp for message header
function formatMessageTimestamp(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit'
  });
}

// Truncate project path
function truncateProject(project) {
  const parts = project.split('/');
  if (parts.length > 3) {
    return '.../' + parts.slice(-2).join('/');
  }
  return project;
}

// Load sessions from Claude Code history
async function loadSessions() {
  const sessionList = document.getElementById('sessionList');
  const sessionCount = document.getElementById('sessionCount');

  try {
    const result = await ipcRenderer.invoke('get-sessions');

    if (result.error) {
      sessionList.innerHTML = `<div class="error-message">${result.error}</div>`;
      sessionCount.textContent = 'Error loading sessions';
      return;
    }

    currentSessions = result.sessions;

    if (currentSessions.length === 0) {
      sessionList.innerHTML = '<div class="loading">No sessions found</div>';
      sessionCount.textContent = '0 sessions';
      return;
    }

    sessionCount.textContent = `${currentSessions.length} session${currentSessions.length !== 1 ? 's' : ''}`;

    // Render session list
    sessionList.innerHTML = currentSessions.map((session, index) => `
      <div class="session-item" data-session-id="${session.id}" data-project-dir="${session.projectDir}">
        <div class="session-timestamp">${formatTimestamp(session.timestamp)}</div>
        <div class="session-preview">${escapeHtml(session.display)}</div>
        <div class="session-meta">
          <div class="session-project">${escapeHtml(truncateProject(session.project))}</div>
          <div class="session-messages">${session.messageCount} msg</div>
        </div>
      </div>
    `).join('');

    // Add click handlers
    document.querySelectorAll('.session-item').forEach(item => {
      item.addEventListener('click', () => {
        const sessionId = item.getAttribute('data-session-id');
        const projectDir = item.getAttribute('data-project-dir');
        loadSessionDetails(sessionId, projectDir);

        // Update active state
        document.querySelectorAll('.session-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
      });
    });

  } catch (error) {
    sessionList.innerHTML = `<div class="error-message">Error: ${error.message}</div>`;
    sessionCount.textContent = 'Error';
  }
}

// Toggle live mode for current session
async function toggleLiveMode() {
  if (!currentSessionId || !currentProjectDir) return;

  isLiveMode = !isLiveMode;
  const liveBtn = document.getElementById('liveToggle');

  if (isLiveMode) {
    liveBtn.classList.add('active');
    await ipcRenderer.invoke('watch-session', currentSessionId, currentProjectDir);
    // Scroll to bottom when entering live mode
    const chatContainer = document.getElementById('chatContainer');
    chatContainer.scrollTop = chatContainer.scrollHeight;
  } else {
    liveBtn.classList.remove('active');
    await ipcRenderer.invoke('stop-watching');
  }
}

// Format a single message to HTML (shared between initial load and live updates)
function renderMessage(msg) {
  let contentHtml = '';
  if (msg.content) {
    contentHtml = marked.parse(msg.content);
  }

  let thinkingHtml = '';
  if (msg.thinking) {
    const thinkingId = 'thinking-' + Math.random().toString(36).substr(2, 9);
    thinkingHtml = `
      <div class="thinking-block">
        <div class="thinking-header" onclick="toggleCollapsible('${thinkingId}')">
          <span class="collapse-icon" id="icon-${thinkingId}">▶</span>
          <span class="thinking-label">💭 Thinking</span>
        </div>
        <div class="thinking-content collapsible" id="${thinkingId}">
          <pre class="thinking-pre">${escapeHtml(msg.thinking)}</pre>
        </div>
      </div>
    `;
  }

  let toolUsesHtml = '';
  if (msg.toolUses && msg.toolUses.length > 0) {
    toolUsesHtml = msg.toolUses.map(tool => {
      const toolId = 'tool-' + Math.random().toString(36).substr(2, 9);
      const resultId = 'result-' + Math.random().toString(36).substr(2, 9);
      const toolResult = toolResultMap.get(tool.id);

      let inputSummary = '';
      let inputDetail = '';
      if (tool.name === 'Bash') {
        inputSummary = (tool.input.command || '').substring(0, 120);
        inputDetail = tool.input.command || '';
      } else if (tool.name === 'Read') {
        inputSummary = tool.input.file_path || '';
        inputDetail = JSON.stringify(tool.input, null, 2);
      } else if (tool.name === 'Write' || tool.name === 'Edit') {
        inputSummary = tool.input.file_path || '';
        inputDetail = JSON.stringify(tool.input, null, 2);
      } else if (tool.name === 'Grep') {
        inputSummary = `"${tool.input.pattern || ''}" ${tool.input.path || ''}`;
        inputDetail = JSON.stringify(tool.input, null, 2);
      } else if (tool.name === 'Glob') {
        inputSummary = tool.input.pattern || '';
        inputDetail = JSON.stringify(tool.input, null, 2);
      } else if (tool.name === 'Task') {
        inputSummary = tool.input.description || '';
        inputDetail = tool.input.prompt ? tool.input.prompt.substring(0, 500) : JSON.stringify(tool.input, null, 2);
      } else {
        inputSummary = Object.values(tool.input).join(', ').substring(0, 100);
        inputDetail = JSON.stringify(tool.input, null, 2);
      }

      let resultHtml = '';
      if (toolResult) {
        const resultContent = toolResult.content || '';
        const isError = toolResult.is_error;
        resultHtml = `
          <div class="tool-result ${isError ? 'tool-result-error' : ''}">
            <div class="tool-result-header" onclick="toggleCollapsible('${resultId}')">
              <span class="collapse-icon" id="icon-${resultId}">▶</span>
              <span class="tool-result-label">${isError ? '❌ Error' : '✅ Result'}</span>
              <span class="tool-result-size">${resultContent.length > 1024 ? (resultContent.length / 1024).toFixed(0) + ' KB' : resultContent.length + ' chars'}</span>
            </div>
            <div class="tool-result-content collapsible" id="${resultId}">
              <pre class="tool-output-pre">${escapeHtml(resultContent)}</pre>
            </div>
          </div>
        `;
      }

      return `
        <div class="tool-use-block">
          <div class="tool-use-header" onclick="toggleCollapsible('${toolId}')">
            <span class="collapse-icon" id="icon-${toolId}">▶</span>
            <span class="tool-name">${escapeHtml(tool.name)}</span>
            <span class="tool-summary">${escapeHtml(inputSummary)}</span>
          </div>
          <div class="tool-use-detail collapsible" id="${toolId}">
            <pre class="tool-input-pre">${escapeHtml(inputDetail)}</pre>
          </div>
          ${resultHtml}
        </div>
      `;
    }).join('');

    toolUsesHtml = `<div class="tool-uses">${toolUsesHtml}</div>`;
  }

  return `
    <div class="message ${msg.role}">
      <div class="message-header">
        <div class="message-role ${msg.role}">${msg.role === 'user' ? 'You' : 'Claude'}</div>
        <div class="message-timestamp">${formatMessageTimestamp(msg.timestamp)}</div>
      </div>
      ${thinkingHtml}
      <div class="message-content">
        ${contentHtml}
      </div>
      ${toolUsesHtml}
    </div>
  `;
}

// Process raw JSONL messages into formatted display messages
function formatRawMessages(messages) {
  return messages
    .filter(msg => (msg.type === 'user' || msg.type === 'assistant') && msg.message)
    .map(msg => {
      if (msg.type === 'user') {
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

        // Register tool results in the shared map
        toolResults.forEach(tr => {
          toolResultMap.set(tr.tool_use_id, tr);
        });

        if (!content && toolResults.length > 0) {
          return { role: 'tool_result', toolResults, timestamp: msg.timestamp };
        }

        return { role: 'user', content, timestamp: msg.timestamp };
      } else if (msg.type === 'assistant') {
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
            .map(block => ({ id: block.id, name: block.name, input: block.input || {} }));
        } else if (typeof msg.message.content === 'string') {
          content = msg.message.content;
        }

        return { role: 'assistant', content, thinking, timestamp: msg.timestamp, toolUses };
      }
      return null;
    })
    .filter(msg => msg !== null && (msg.content || msg.toolUses?.length > 0 || msg.toolResults?.length > 0));
}

// Load full session conversation
async function loadSessionDetails(sessionId, projectDir) {
  const chatContainer = document.getElementById('chatContainer');
  const chatHeader = document.getElementById('chatHeader');

  // Stop previous live mode
  if (isLiveMode) {
    isLiveMode = false;
    await ipcRenderer.invoke('stop-watching');
  }

  currentSessionId = sessionId;
  currentProjectDir = projectDir;

  // Show loading state
  chatContainer.innerHTML = '<div class="loading">Loading conversation...</div>';

  try {
    const result = await ipcRenderer.invoke('get-session-details', sessionId, projectDir);

    if (result.error) {
      chatContainer.innerHTML = `<div class="error-message">${result.error}</div>`;
      return;
    }

    const session = currentSessions.find(s => s.id === sessionId);

    // Update header with live toggle button
    chatHeader.innerHTML = `
      <div class="session-header">
        <div class="session-header-top">
          <div class="session-title">${escapeHtml(session.display)}</div>
          <button class="live-toggle" id="liveToggle" onclick="toggleLiveMode()" title="Auto-refresh when session updates">
            <span class="live-dot"></span>
            <span class="live-label">Live</span>
          </button>
        </div>
        <div class="session-info">
          <span>${formatTimestamp(session.timestamp)}</span>
          <span>•</span>
          <span>${escapeHtml(session.project)}</span>
          <span>•</span>
          <span id="messageCount">${result.messages.length} messages</span>
        </div>
      </div>
    `;

    // Reset tool result map and populate from this session's messages
    toolResultMap = new Map();
    result.messages.forEach(msg => {
      if (msg.role === 'tool_result' && msg.toolResults) {
        msg.toolResults.forEach(tr => {
          toolResultMap.set(tr.tool_use_id, tr);
        });
      }
    });

    // Render messages (skip standalone tool_result messages, they're shown inline)
    chatContainer.innerHTML = result.messages
      .filter(msg => msg.role !== 'tool_result')
      .map(msg => renderMessage(msg)).join('');

    // Scroll to top
    chatContainer.scrollTop = 0;

  } catch (error) {
    chatContainer.innerHTML = `<div class="error-message">Error loading conversation: ${error.message}</div>`;
  }
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Toggle collapsible sections
function toggleCollapsible(id) {
  const el = document.getElementById(id);
  const icon = document.getElementById('icon-' + id);
  if (el) {
    const isHidden = el.style.display === 'none' || !el.style.display;
    el.style.display = isHidden ? 'block' : 'none';
    if (icon) icon.textContent = isHidden ? '▼' : '▶';
  }
}

// Make it globally accessible for onclick handlers
window.toggleCollapsible = toggleCollapsible;
window.toggleLiveMode = toggleLiveMode;

// Handle live messages from main process
ipcRenderer.on('live-messages', (event, data) => {
  if (data.sessionId !== currentSessionId || !isLiveMode) return;

  const chatContainer = document.getElementById('chatContainer');
  const formatted = formatRawMessages(data.messages);
  const displayMessages = formatted.filter(msg => msg.role !== 'tool_result');

  if (displayMessages.length === 0) return;

  // Append new messages
  const newHtml = displayMessages.map(msg => renderMessage(msg)).join('');
  chatContainer.insertAdjacentHTML('beforeend', newHtml);

  // Update message count in header
  const countEl = document.getElementById('messageCount');
  if (countEl) {
    const currentCount = parseInt(countEl.textContent) || 0;
    const newCount = currentCount + displayMessages.length;
    countEl.textContent = `${newCount} messages`;
  }

  // Update message count in sidebar
  const sidebarItem = document.querySelector(`.session-item[data-session-id="${currentSessionId}"]`);
  if (sidebarItem) {
    const msgEl = sidebarItem.querySelector('.session-messages');
    if (msgEl) {
      const sidebarCount = parseInt(msgEl.textContent) || 0;
      msgEl.textContent = `${sidebarCount + displayMessages.length} msg`;
    }
  }

  // Auto-scroll to bottom
  chatContainer.scrollTop = chatContainer.scrollHeight;
});

// Initialize on load
window.addEventListener('DOMContentLoaded', () => {
  loadSessions();
});
