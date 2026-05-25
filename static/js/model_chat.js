/**
 * 数据飞轮 - 模型对话模块（ChatGPT 风格重构）
 * 提供多模型对话、会话管理、消息收发、Markdown 渲染、推理耗时展示
 */

// ========== DOM 元素引用 ==========
const modelSelect = document.getElementById('modelSelect');
const sessionListEl = document.getElementById('sessionList');
const messageArea = document.getElementById('messageArea');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
const newChatBtn = document.getElementById('newChatBtn');
const inputWrapper = document.getElementById('inputWrapper');
const currentSessionInfo = document.getElementById('currentSessionInfo');

// ========== 状态管理 ==========
let currentSessionId = null;
let isSending = false;

// ========== 初始化 ==========
document.addEventListener('DOMContentLoaded', async () => {
    await loadModelList();
    await loadSessionList();
    bindEvents();
    chatInput.focus();
});

// ========== 模型列表 ==========
async function loadModelList() {
    try {
        const models = await apiGet('/api/chat/models');
        modelSelect.innerHTML = '';
        models.forEach(name => {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = name;
            modelSelect.appendChild(option);
        });
    } catch (e) {
        showToast('加载模型列表失败', 'error');
    }
}

// ========== 会话列表 ==========
async function loadSessionList() {
    try {
        const sessions = await apiGet('/api/chat/sessions');
        renderSessionList(sessions);
    } catch (e) {
        showToast('加载会话列表失败', 'error');
    }
}

function renderSessionList(sessions) {
    sessionListEl.innerHTML = '';
    if (sessions.length === 0) {
        sessionListEl.innerHTML = '<div style="padding:20px 8px; text-align:center; color:#9ca3af; font-size:13px;">暂无对话</div>';
        return;
    }
    sessions.forEach(session => {
        const item = createSessionItem(session);
        sessionListEl.appendChild(item);
    });
}

function createSessionItem(session) {
    const isActive = currentSessionId === session.id;
    const item = document.createElement('div');
    item.style.cssText = `
        display:flex; align-items:center; padding:10px 12px; margin-bottom:2px;
        border-radius:8px; cursor:pointer; transition:background 0.15s;
        background:${isActive ? '#e0e7ff' : 'transparent'};
    `;
    item.dataset.sessionId = session.id;

    // 悬停效果
    item.addEventListener('mouseenter', () => {
        if (currentSessionId !== session.id) item.style.background = '#f3f4f6';
    });
    item.addEventListener('mouseleave', () => {
        if (currentSessionId !== session.id) item.style.background = 'transparent';
    });

    // 图标
    const icon = document.createElement('div');
    icon.style.cssText = 'flex-shrink:0; margin-right:10px; display:flex; align-items:center;';
    icon.innerHTML = '<svg style="width:16px; height:16px; color:#6b7280;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"></path></svg>';

    // 信息区
    const infoDiv = document.createElement('div');
    infoDiv.style.cssText = 'flex:1; min-width:0;';
    infoDiv.innerHTML = `
        <div style="font-size:13px; font-weight:${isActive ? '600' : '400'}; color:${isActive ? '#1d4ed8' : '#374151'}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(session.title || '新对话')}</div>
        <div style="font-size:11px; color:#9ca3af; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(session.model_name)}</div>
    `;

    // 删除按钮
    const deleteBtn = document.createElement('button');
    deleteBtn.style.cssText = `
        flex-shrink:0; margin-left:6px; padding:4px; border:none; background:transparent;
        cursor:pointer; color:#d1d5db; border-radius:4px; display:flex; align-items:center;
        transition:color 0.15s, background 0.15s; opacity:0;
    `;
    deleteBtn.innerHTML = '<svg style="width:14px; height:14px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>';
    deleteBtn.addEventListener('mouseenter', () => { deleteBtn.style.color = '#ef4444'; deleteBtn.style.background = '#fee2e2'; });
    deleteBtn.addEventListener('mouseleave', () => { deleteBtn.style.color = '#d1d5db'; deleteBtn.style.background = 'transparent'; });

    // 悬停时显示删除按钮
    item.addEventListener('mouseenter', () => { deleteBtn.style.opacity = '1'; });
    item.addEventListener('mouseleave', () => { deleteBtn.style.opacity = '0'; });

    deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const confirmed = await showConfirm('删除对话', '确定要删除这个对话吗？删除后不可恢复。');
        if (!confirmed) return;
        try {
            await apiDelete(`/api/chat/sessions/${session.id}`);
            if (currentSessionId === session.id) {
                currentSessionId = null;
                renderEmptyState();
                currentSessionInfo.textContent = '';
            }
            await loadSessionList();
            showToast('对话已删除', 'success');
        } catch (e) {
            showToast('删除对话失败', 'error');
        }
    });

    item.appendChild(icon);
    item.appendChild(infoDiv);
    item.appendChild(deleteBtn);

    item.addEventListener('click', () => switchSession(session.id));
    return item;
}

// ========== 切换会话 ==========
async function switchSession(sessionId) {
    if (currentSessionId === sessionId) return;
    currentSessionId = sessionId;
    await loadSessionList();
    await loadMessages(sessionId);
    // 更新顶部信息
    updateSessionInfo();
}

function updateSessionInfo() {
    if (!currentSessionId) {
        currentSessionInfo.textContent = '';
        return;
    }
    // 从会话列表找到当前会话
    const items = sessionListEl.querySelectorAll('[data-session-id]');
    items.forEach(item => {
        if (item.dataset.sessionId === currentSessionId) {
            const titleEl = item.querySelector('div > div:first-child');
            const modelEl = item.querySelector('div > div:last-child');
            if (titleEl && modelEl) {
                currentSessionInfo.textContent = `${modelEl.textContent} · ${titleEl.textContent}`;
            }
        }
    });
}

// ========== 消息加载 ==========
async function loadMessages(sessionId) {
    try {
        const messages = await apiGet(`/api/chat/sessions/${sessionId}/messages`);
        renderMessages(messages);
    } catch (e) {
        showToast('加载消息失败', 'error');
    }
}

function renderMessages(messages) {
    clearMessageArea();
    if (messages.length === 0) {
        renderEmptyState();
        return;
    }
    messages.forEach(msg => {
        appendMessageBubble(msg);
    });
    scrollToBottom();
}

function clearMessageArea() {
    messageArea.innerHTML = '';
}

function renderEmptyState() {
    messageArea.innerHTML = `
        <div id="emptyState" style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; color:#9ca3af;">
            <svg style="width:48px; height:48px; margin-bottom:16px; opacity:0.4;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"></path></svg>
            <p style="font-size:15px; margin:0;">选择模型并开始新对话</p>
            <p style="font-size:13px; margin-top:6px;">Shift + Enter 换行，Enter 发送</p>
        </div>
    `;
}

// ========== 消息气泡 ==========
function appendMessageBubble(msg) {
    // 移除空状态
    const emptyEl = messageArea.querySelector('#emptyState');
    if (emptyEl) emptyEl.remove();

    const wrapper = createMessageBubble(msg);
    messageArea.appendChild(wrapper);
    scrollToBottom();
    return wrapper;
}

function createMessageBubble(msg) {
    const isUser = msg.role === 'user';
    const wrapper = document.createElement('div');
    wrapper.style.cssText = `
        display:flex; ${isUser ? 'justify-content:flex-end;' : 'justify-content:flex-start;'}
        margin-bottom:16px;
    `;

    if (isUser) {
        // 用户消息：右侧浅灰气泡
        const bubble = document.createElement('div');
        bubble.style.cssText = `
            max-width:70%; padding:10px 14px; border-radius:12px;
            background:#f3f4f6; color:#111827; font-size:13px; line-height:1.6;
            word-break:break-word; white-space:pre-wrap;
        `;
        bubble.textContent = msg.content;
        wrapper.appendChild(bubble);
    } else {
        // AI消息：左侧带头像
        const avatarWrap = document.createElement('div');
        avatarWrap.style.cssText = 'flex-shrink:0; margin-right:10px; margin-top:2px;';
        avatarWrap.innerHTML = '<div style="width:30px; height:30px; border-radius:6px; background:#f3f4f6; display:flex; align-items:center; justify-content:center;"><svg style="width:18px; height:18px; color:#6b7280;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"></path></svg></div>';

        const contentWrap = document.createElement('div');
        contentWrap.style.cssText = 'max-width:70%; min-width:0;';

        const bubble = document.createElement('div');
        bubble.style.cssText = `
            padding:10px 14px; border-radius:12px;
            background:#f9fafb; color:#111827; font-size:13px; line-height:1.6;
            word-break:break-word; border:1px solid #e5e7eb;
        `;
        bubble.setAttribute('data-message-text', msg.content);

        // Markdown 渲染
        bubble.innerHTML = renderMarkdown(msg.content);

        contentWrap.appendChild(bubble);

        // 底部操作栏：复制图标 + 耗时标签
        const hasDuration = msg.duration_ms !== undefined && msg.duration_ms !== null;
        if (hasDuration) {
            const bottomBar = document.createElement('div');
            bottomBar.style.cssText = `
                margin-top:4px; display:inline-flex; align-items:center; gap:10px;
            `;

            // 复制图标
            const copyBtn = document.createElement('button');
            copyBtn.style.cssText = `
                background:none; border:none; cursor:pointer;
                color:#9ca3af; padding:2px; display:flex; align-items:center;
                transition:color 0.2s;
            `;
            copyBtn.title = '复制';
            copyBtn.innerHTML = '<svg style="width:14px; height:14px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>';
            copyBtn.addEventListener('mouseenter', () => { copyBtn.style.color = '#374151'; });
            copyBtn.addEventListener('mouseleave', () => { copyBtn.style.color = '#9ca3af'; });
            copyBtn.addEventListener('click', () => { copyMessageText(copyBtn); });
            bottomBar.appendChild(copyBtn);

            // 耗时标签
            const durationTag = document.createElement('div');
            const seconds = (msg.duration_ms / 1000).toFixed(1);
            durationTag.style.cssText = `
                font-size:11px; color:#9ca3af;
                display:inline-flex; align-items:center; gap:4px;
                background:#f3f4f6; padding:3px 8px; border-radius:4px;
            `;
            durationTag.innerHTML = `<svg style="width:12px; height:12px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>耗时 ${seconds}s`;
            bottomBar.appendChild(durationTag);

            contentWrap.appendChild(bottomBar);
        } else {
            // 没有耗时时，复制按钮仍显示在底部
            const copyBtn = document.createElement('button');
            copyBtn.style.cssText = `
                margin-top:4px; background:none; border:none; cursor:pointer;
                color:#9ca3af; padding:2px; display:flex; align-items:center;
                transition:color 0.2s;
            `;
            copyBtn.title = '复制';
            copyBtn.innerHTML = '<svg style="width:14px; height:14px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>';
            copyBtn.addEventListener('mouseenter', () => { copyBtn.style.color = '#374151'; });
            copyBtn.addEventListener('mouseleave', () => { copyBtn.style.color = '#9ca3af'; });
            copyBtn.addEventListener('click', () => { copyMessageText(copyBtn); });
            contentWrap.appendChild(copyBtn);
        }

        wrapper.appendChild(avatarWrap);
        wrapper.appendChild(contentWrap);
    }

    return wrapper;
}

function copyMessageText(btn) {
    // 从按钮向上遍历，找到包含 data-message-text 气泡的容器
    let container = btn.parentElement;
    while (container && !container.querySelector('[data-message-text]')) {
        container = container.parentElement;
    }
    const bubble = container ? container.querySelector('[data-message-text]') : null;
    const text = bubble ? bubble.getAttribute('data-message-text') : '';
    navigator.clipboard.writeText(text).then(() => {
        const origTitle = btn.title;
        btn.title = '已复制!';
        btn.style.color = '#374151';
        setTimeout(() => { btn.title = origTitle; btn.style.color = '#9ca3af'; }, 1500);
    });
}

// ========== Markdown 简易渲染 ==========
function renderMarkdown(text) {
    if (!text) return '';
    let html = escapeHtml(text);

    // 代码块 ```lang\n...\n```
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
        return `<pre style="background:#1e293b; color:#e2e8f0; padding:12px 16px; border-radius:8px; overflow-x:auto; margin:8px 0; font-size:13px; line-height:1.5; font-family:Menlo,Monaco,Consolas,monospace;"><code>${code.trim()}</code></pre>`;
    });

    // 行内代码 `...`
    html = html.replace(/`([^`]+)`/g, '<code style="background:#e5e7eb; color:#1f2937; padding:2px 6px; border-radius:4px; font-size:13px; font-family:Menlo,Monaco,Consolas,monospace;">$1</code>');

    // 粗体 **...**
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // 换行
    html = html.replace(/\n/g, '<br>');

    return html;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ========== 发送消息 ==========
async function sendMessage() {
    const content = chatInput.value.trim();
    if (!content || isSending) return;

    // 如果没有选中会话，先创建一个
    if (!currentSessionId) {
        const modelName = modelSelect.value;
        if (!modelName) {
            showToast('请先选择模型', 'warning');
            return;
        }
        try {
            const session = await apiPost('/api/chat/sessions', { model_name: modelName });
            currentSessionId = session.id;
            await loadSessionList();
            clearMessageArea();
            updateSessionInfo();
        } catch (e) {
            showToast('创建会话失败', 'error');
            return;
        }
    }

    isSending = true;
    sendBtn.disabled = true;
    sendBtn.style.background = '#93c5fd';
    sendBtn.style.cursor = 'not-allowed';
    chatInput.value = '';
    autoResizeInput();

    // 立即显示用户消息
    appendMessageBubble({ role: 'user', content });

    // 显示"正在思考..."
    const thinkingEl = appendThinkingBubble();

    try {
        const result = await apiPost(`/api/chat/sessions/${currentSessionId}/messages`, { content });
        // 移除thinking
        thinkingEl.remove();
        // 显示AI回复（带耗时）
        appendMessageBubble({
            role: 'assistant',
            content: result.assistant_message.content,
            duration_ms: result.assistant_message.duration_ms,
        });
        // 更新会话列表（标题可能变了）
        await loadSessionList();
        updateSessionInfo();
    } catch (e) {
        thinkingEl.remove();
        showToast('发送消息失败', 'error');
    } finally {
        isSending = false;
        sendBtn.disabled = false;
        sendBtn.style.background = '#2563eb';
        sendBtn.style.cursor = 'pointer';
        chatInput.focus();
    }
}

function appendThinkingBubble() {
    // 移除空状态
    const emptyEl = messageArea.querySelector('#emptyState');
    if (emptyEl) emptyEl.remove();

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex; justify-content:flex-start; margin-bottom:16px;';

    const avatarWrap = document.createElement('div');
    avatarWrap.style.cssText = 'flex-shrink:0; margin-right:10px; margin-top:2px;';
    avatarWrap.innerHTML = '<div style="width:30px; height:30px; border-radius:6px; background:#f3f4f6; display:flex; align-items:center; justify-content:center;"><svg style="width:18px; height:18px; color:#6b7280;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"></path></svg></div>';

    const bubble = document.createElement('div');
    bubble.style.cssText = `
        padding:10px 14px; border-radius:12px;
        background:#f9fafb; color:#9ca3af; font-size:13px;
        display:flex; align-items:center; gap:8px;
        border:1px solid #e5e7eb;
    `;
    bubble.innerHTML = `
        <svg style="width:16px; height:16px; animation:spin 1s linear infinite;" fill="none" viewBox="0 0 24 24">
            <circle style="opacity:0.25;" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path style="opacity:0.75;" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
        </svg>
        正在思考...
    `;

    wrapper.appendChild(avatarWrap);
    wrapper.appendChild(bubble);
    messageArea.appendChild(wrapper);
    scrollToBottom();
    return wrapper;
}

// ========== 新建对话 ==========
async function createNewChat() {
    const modelName = modelSelect.value;
    if (!modelName) {
        showToast('请先选择模型', 'warning');
        return;
    }
    try {
        const session = await apiPost('/api/chat/sessions', { model_name: modelName });
        currentSessionId = session.id;
        await loadSessionList();
        clearMessageArea();
        renderEmptyState();
        updateSessionInfo();
        chatInput.focus();
    } catch (e) {
        showToast('创建会话失败', 'error');
    }
}

// ========== 工具函数 ==========
function scrollToBottom() {
    requestAnimationFrame(() => {
        messageArea.scrollTop = messageArea.scrollHeight;
    });
}

/** 输入框自动调高 */
function autoResizeInput() {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
}

// ========== 事件绑定 ==========
function bindEvents() {
    newChatBtn.addEventListener('click', createNewChat);
    sendBtn.addEventListener('click', sendMessage);

    // Enter发送，Shift+Enter换行
    chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    // 输入框自动调高
    chatInput.addEventListener('input', autoResizeInput);

    // 输入框聚焦样式
    chatInput.addEventListener('focus', () => {
        inputWrapper.style.borderColor = '#2563eb';
        inputWrapper.style.boxShadow = '0 0 0 2px rgba(37,99,235,0.2)';
    });
    chatInput.addEventListener('blur', () => {
        inputWrapper.style.borderColor = '#e5e7eb';
        inputWrapper.style.boxShadow = 'none';
    });
}
