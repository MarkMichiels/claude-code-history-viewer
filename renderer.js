const { ipcRenderer } = require('electron');
const { marked } = require('marked');
const hljs = require('highlight.js');

let currentSessions = [];
let currentSessionId = null;

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

// Load full session conversation
async function loadSessionDetails(sessionId, projectDir) {
  const chatContainer = document.getElementById('chatContainer');
  const chatHeader = document.getElementById('chatHeader');

  currentSessionId = sessionId;

  // Show loading state
  chatContainer.innerHTML = '<div class="loading">Loading conversation...</div>';

  try {
    const result = await ipcRenderer.invoke('get-session-details', sessionId, projectDir);

    if (result.error) {
      chatContainer.innerHTML = `<div class="error-message">${result.error}</div>`;
      return;
    }

    const session = currentSessions.find(s => s.id === sessionId);

    // Update header
    chatHeader.innerHTML = `
      <div class="session-header">
        <div class="session-title">${escapeHtml(session.display)}</div>
        <div class="session-info">
          <span>${formatTimestamp(session.timestamp)}</span>
          <span>•</span>
          <span>${escapeHtml(session.project)}</span>
          <span>•</span>
          <span>${result.messages.length} messages</span>
        </div>
      </div>
    `;

    // Build a lookup of tool results by tool_use_id
    const toolResultMap = new Map();
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
      .map(msg => {
      let contentHtml = '';

      // Process content with markdown
      if (msg.content) {
        contentHtml = marked.parse(msg.content);
      }

      // Render thinking block if present
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

      // Render tool uses with input and results
      let toolUsesHtml = '';
      if (msg.toolUses && msg.toolUses.length > 0) {
        toolUsesHtml = msg.toolUses.map(tool => {
          const toolId = 'tool-' + Math.random().toString(36).substr(2, 9);
          const resultId = 'result-' + Math.random().toString(36).substr(2, 9);
          const toolResult = toolResultMap.get(tool.id);

          // Format tool input based on tool type
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

          // Render result if available
          let resultHtml = '';
          if (toolResult) {
            const resultContent = toolResult.content || '';
            const truncated = resultContent.length > 500;
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
    }).join('');

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

// Initialize on load
window.addEventListener('DOMContentLoaded', () => {
  loadSessions();
});
