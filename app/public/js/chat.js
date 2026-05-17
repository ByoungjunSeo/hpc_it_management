(function() {
  'use strict';

  const messagesEl = document.getElementById('chatMessages');
  const inputEl = document.getElementById('chatInput');
  const sendBtn = document.getElementById('chatSendBtn');
  const sidebar = document.getElementById('chatSidebar');
  const sidebarToggle = document.getElementById('sidebarToggle');

  // Conversation history (sent to server)
  let conversationMessages = [];
  let isStreaming = false;

  var sidebarExpand = document.getElementById('sidebarExpand');

  // ── Sidebar toggle ──
  sidebarToggle.addEventListener('click', function() {
    sidebar.classList.add('collapsed');
  });

  sidebarExpand.addEventListener('click', function() {
    sidebar.classList.remove('collapsed');
  });

  // ── Auto-resize textarea ──
  inputEl.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
  });

  // ── Send on Enter (Shift+Enter for newline) ──
  inputEl.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  sendBtn.addEventListener('click', sendMessage);

  // ── Suggestion buttons ──
  window.sendSuggestion = function(btn) {
    inputEl.value = btn.textContent;
    sendMessage();
  };

  // ── Send message ──
  function sendMessage() {
    const text = inputEl.value.trim();
    if (!text || isStreaming) return;

    // Remove welcome screen
    var welcome = messagesEl.querySelector('.chat-welcome');
    if (welcome) welcome.remove();

    // Add user message
    appendMessage('user', text);
    conversationMessages.push({ role: 'user', content: text });

    // Clear input
    inputEl.value = '';
    inputEl.style.height = 'auto';

    // Start streaming response
    streamResponse();
  }

  // ── Append message bubble ──
  function appendMessage(role, content, isHtml) {
    var div = document.createElement('div');
    div.className = 'chat-message ' + role;

    var avatar = document.createElement('div');
    avatar.className = 'chat-avatar';
    avatar.textContent = role === 'user' ? '👤' : '🤖';

    var bubble = document.createElement('div');
    bubble.className = 'chat-bubble';
    if (isHtml) {
      bubble.innerHTML = content;
    } else {
      bubble.textContent = content;
    }

    div.appendChild(avatar);
    div.appendChild(bubble);
    messagesEl.appendChild(div);
    scrollToBottom();
    return bubble;
  }

  // ── Stream response from server ──
  function streamResponse() {
    isStreaming = true;
    sendBtn.disabled = true;

    // Create assistant message placeholder
    var bubble = appendMessage('assistant', '');
    var loadingHtml = '<div class="chat-loading"><div class="dots"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div> 생각 중...</div>';
    bubble.innerHTML = loadingHtml;

    var fullText = '';

    fetch('/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: conversationMessages })
    }).then(function(response) {
      if (!response.ok) {
        throw new Error('서버 오류: ' + response.status);
      }
      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';

      function read() {
        reader.read().then(function(result) {
          if (result.done) {
            finishStream(bubble, fullText);
            return;
          }

          buffer += decoder.decode(result.value, { stream: true });
          var lines = buffer.split('\n');
          buffer = lines.pop();

          for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line.startsWith('data: ')) continue;
            var data = line.substring(6);

            if (data === '[DONE]') {
              finishStream(bubble, fullText);
              return;
            }

            try {
              var parsed = JSON.parse(data);
              if (parsed.error) {
                bubble.innerHTML = '<div class="chat-error">' + escapeHtml(parsed.error) + '</div>';
                isStreaming = false;
                sendBtn.disabled = false;
                return;
              }
              if (parsed.content) {
                fullText += parsed.content;
                bubble.innerHTML = renderMarkdown(fullText) + '<span class="typing-cursor">▌</span>';
                scrollToBottom();
              }
            } catch (e) {
              // skip
            }
          }

          read();
        }).catch(function(err) {
          bubble.innerHTML = '<div class="chat-error">스트리밍 오류: ' + escapeHtml(err.message) + '</div>';
          isStreaming = false;
          sendBtn.disabled = false;
        });
      }

      read();
    }).catch(function(err) {
      bubble.innerHTML = '<div class="chat-error">연결 오류: ' + escapeHtml(err.message) + '</div>';
      isStreaming = false;
      sendBtn.disabled = false;
    });
  }

  // ── Finish streaming ──
  function finishStream(bubble, fullText) {
    isStreaming = false;
    sendBtn.disabled = false;

    if (!fullText.trim()) {
      bubble.innerHTML = '<span style="color:var(--text-light)">응답이 비어있습니다.</span>';
      return;
    }

    conversationMessages.push({ role: 'assistant', content: fullText });

    // Keep only last 20 messages
    if (conversationMessages.length > 20) {
      conversationMessages = conversationMessages.slice(-20);
    }

    // Render final markdown with interactive elements
    bubble.innerHTML = renderMarkdown(fullText);
    processCodeBlocks(bubble, fullText);
    scrollToBottom();
  }

  // ── Simple Markdown renderer ──
  function renderMarkdown(text) {
    // Process code blocks first (preserve them)
    var codeBlocks = [];
    var processed = text.replace(/```(\w*)\n?([\s\S]*?)```/g, function(match, lang, code) {
      var idx = codeBlocks.length;
      codeBlocks.push({ lang: lang, code: code.trim() });
      return '%%CODEBLOCK_' + idx + '%%';
    });

    // Escape HTML in non-code parts
    processed = escapeHtml(processed);

    // Inline code
    processed = processed.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold
    processed = processed.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // Italic
    processed = processed.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // Headers
    processed = processed.replace(/^### (.+)$/gm, '<h4>$1</h4>');
    processed = processed.replace(/^## (.+)$/gm, '<h3>$1</h3>');
    processed = processed.replace(/^# (.+)$/gm, '<h2>$1</h2>');

    // Unordered lists
    processed = processed.replace(/^[*\-] (.+)$/gm, '<li>$1</li>');
    processed = processed.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

    // Ordered lists
    processed = processed.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

    // Line breaks to paragraphs
    processed = processed.replace(/\n\n/g, '</p><p>');
    processed = processed.replace(/\n/g, '<br>');
    processed = '<p>' + processed + '</p>';

    // Clean up empty paragraphs
    processed = processed.replace(/<p><\/p>/g, '');
    processed = processed.replace(/<p>(<h[234]>)/g, '$1');
    processed = processed.replace(/(<\/h[234]>)<\/p>/g, '$1');
    processed = processed.replace(/<p>(<ul>)/g, '$1');
    processed = processed.replace(/(<\/ul>)<\/p>/g, '$1');

    // Restore code blocks
    processed = processed.replace(/%%CODEBLOCK_(\d+)%%/g, function(match, idx) {
      var block = codeBlocks[parseInt(idx)];
      var lang = block.lang;
      var code = escapeHtml(block.code);

      if (lang === 'chart' || lang === 'excel' || lang === 'sql') {
        return '<pre class="code-block" data-lang="' + lang + '"><code>' + code + '</code></pre>';
      }
      return '<pre><code>' + code + '</code></pre>';
    });

    // Fix wrapping issues
    processed = processed.replace(/<p><pre/g, '<pre');
    processed = processed.replace(/<\/pre><\/p>/g, '</pre>');

    return processed;
  }

  // ── Process special code blocks (chart, sql, excel) ──
  function processCodeBlocks(bubble, fullText) {
    // Extract code blocks from raw text
    var regex = /```(\w+)\n?([\s\S]*?)```/g;
    var match;
    var blocks = [];
    while ((match = regex.exec(fullText)) !== null) {
      blocks.push({ lang: match[1], code: match[2].trim() });
    }

    // Find corresponding pre elements
    var preElements = bubble.querySelectorAll('pre.code-block');

    blocks.forEach(function(block, i) {
      // Find the pre element for this block
      var preEl = null;
      for (var j = 0; j < preElements.length; j++) {
        if (preElements[j].dataset.lang === block.lang && !preElements[j].dataset.processed) {
          preEl = preElements[j];
          preEl.dataset.processed = 'true';
          break;
        }
      }

      if (block.lang === 'chart') {
        renderChart(bubble, preEl, block.code);
      } else if (block.lang === 'sql') {
        renderSqlButton(bubble, preEl, block.code);
      } else if (block.lang === 'excel') {
        renderExcelButton(bubble, preEl, block.code);
      }
    });
  }

  // ── Chart rendering ──
  function renderChart(bubble, preEl, code) {
    try {
      var config = JSON.parse(code);
      var container = document.createElement('div');
      container.className = 'chat-chart-container';
      var canvas = document.createElement('canvas');
      container.appendChild(canvas);

      if (preEl) {
        preEl.parentNode.replaceChild(container, preEl);
      } else {
        bubble.appendChild(container);
      }

      new Chart(canvas, config);
    } catch (e) {
      // If JSON parse fails, keep the code block and add error note
      if (preEl) {
        var errDiv = document.createElement('div');
        errDiv.className = 'chat-error';
        errDiv.textContent = '차트 렌더링 실패: ' + e.message;
        preEl.parentNode.insertBefore(errDiv, preEl.nextSibling);
      }
    }
  }

  // ── SQL execution button ──
  function renderSqlButton(bubble, preEl, code) {
    var wrapper = document.createElement('div');
    var btn = document.createElement('button');
    btn.className = 'chat-action-btn sql-btn';
    btn.innerHTML = '&#9654; SQL 실행';
    btn.onclick = function() {
      executeSql(wrapper, btn, code);
    };
    wrapper.appendChild(btn);

    if (preEl) {
      preEl.parentNode.insertBefore(wrapper, preEl.nextSibling);
    } else {
      bubble.appendChild(wrapper);
    }
  }

  function executeSql(wrapper, btn, sql) {
    btn.disabled = true;
    btn.textContent = '실행 중...';

    fetch('/chat/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: sql })
    }).then(function(r) { return r.json(); })
    .then(function(data) {
      btn.innerHTML = '&#9654; SQL 실행';
      btn.disabled = false;

      // Remove previous result
      var prev = wrapper.querySelector('.chat-sql-result');
      if (prev) prev.remove();
      var prevErr = wrapper.querySelector('.chat-error');
      if (prevErr) prevErr.remove();

      if (data.error) {
        var errDiv = document.createElement('div');
        errDiv.className = 'chat-error';
        errDiv.textContent = data.error;
        wrapper.appendChild(errDiv);
        return;
      }

      var resultDiv = document.createElement('div');
      resultDiv.className = 'chat-sql-result';

      if (data.rows.length === 0) {
        resultDiv.innerHTML = '<p style="color:var(--text-light); font-size:13px;">결과가 없습니다.</p>';
      } else {
        var html = '<table><thead><tr>';
        data.columns.forEach(function(col) {
          html += '<th>' + escapeHtml(col) + '</th>';
        });
        html += '</tr></thead><tbody>';
        data.rows.forEach(function(row) {
          html += '<tr>';
          data.columns.forEach(function(col) {
            var val = row[col] != null ? String(row[col]) : '';
            html += '<td title="' + escapeHtml(val) + '">' + escapeHtml(val) + '</td>';
          });
          html += '</tr>';
        });
        html += '</tbody></table>';
        if (data.totalRows > 100) {
          html += '<p style="color:var(--text-light); font-size:12px; margin-top:4px;">총 ' + data.totalRows + '행 중 100행만 표시</p>';
        }
        resultDiv.innerHTML = html;
      }

      wrapper.appendChild(resultDiv);
      scrollToBottom();
    }).catch(function(err) {
      btn.innerHTML = '&#9654; SQL 실행';
      btn.disabled = false;
      var errDiv = document.createElement('div');
      errDiv.className = 'chat-error';
      errDiv.textContent = '요청 실패: ' + err.message;
      wrapper.appendChild(errDiv);
    });
  }

  // ── Excel download button ──
  function renderExcelButton(bubble, preEl, code) {
    var wrapper = document.createElement('div');
    var btn = document.createElement('button');
    btn.className = 'chat-action-btn excel-btn';
    btn.innerHTML = '&#128196; 엑셀 다운로드';
    btn.onclick = function() {
      downloadExcel(btn, code);
    };
    wrapper.appendChild(btn);

    if (preEl) {
      preEl.parentNode.insertBefore(wrapper, preEl.nextSibling);
    } else {
      bubble.appendChild(wrapper);
    }
  }

  function downloadExcel(btn, code) {
    try {
      var data = JSON.parse(code);
      if (!data.headers || !data.rows) {
        alert('엑셀 데이터 형식이 올바르지 않습니다.');
        return;
      }

      btn.disabled = true;
      btn.textContent = '생성 중...';

      fetch('/chat/excel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      }).then(function(r) {
        if (!r.ok) throw new Error('서버 오류');
        return r.blob();
      }).then(function(blob) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = (data.filename || 'export') + '.xlsx';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        btn.innerHTML = '&#128196; 엑셀 다운로드';
        btn.disabled = false;
      }).catch(function(err) {
        btn.innerHTML = '&#128196; 엑셀 다운로드';
        btn.disabled = false;
        alert('엑셀 생성 실패: ' + err.message);
      });
    } catch (e) {
      alert('엑셀 데이터 파싱 실패: ' + e.message);
    }
  }

  // ── Utilities ──
  function escapeHtml(str) {
    if (!str) return '';
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
})();
