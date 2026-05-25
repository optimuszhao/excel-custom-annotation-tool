/**
 * 数据飞轮 - Prompt 管理页面交互逻辑
 */

// ========== 状态管理 ==========
const state = {
    scenes: [],           // 场景列表
    currentSceneId: null, // 当前选中场景ID
    prompts: [],          // 当前场景的Prompt列表
    currentPromptId: null,// 当前选中编辑的Prompt ID
    isEditing: false,     // 是否处于编辑状态
    originalContent: '',  // 编辑前原始内容（用于取消恢复）
};

// ========== 初始化 ==========
document.addEventListener('DOMContentLoaded', async () => {
    await loadScenes();
    bindKeyboardShortcuts();
});

// ========== 场景相关 ==========

/** 加载场景列表 */
async function loadScenes() {
    try {
        state.scenes = await apiGet('/api/scenes');
        renderSceneList();

        // 从URL参数恢复场景选中
        const urlSceneId = getUrlParam('scene_id');
        if (urlSceneId && state.scenes.find(s => s.id == urlSceneId)) {
            selectScene(parseInt(urlSceneId));
        } else if (state.scenes.length > 0) {
            selectScene(state.scenes[0].id);
        }
    } catch (e) {
        console.error('加载场景失败:', e);
    }
}

/** 渲染场景列表 */
function renderSceneList() {
    const container = document.getElementById('scene-list');
    if (!state.scenes.length) {
        container.innerHTML = '<div class="pm-file-empty"><span>暂无场景</span></div>';
        return;
    }
    container.innerHTML = state.scenes.map(scene => `
        <div class="pm-sidebar-item ${scene.id === state.currentSceneId ? 'pm-sidebar-item--active' : ''}"
             data-scene-id="${scene.id}" onclick="selectScene(${scene.id})">
            ${scene.name}
        </div>
    `).join('');
}

/** 选中场景 */
async function selectScene(sceneId) {
    state.currentSceneId = sceneId;
    state.currentPromptId = null;
    state.isEditing = false;
    setUrlParam('scene_id', sceneId);
    renderSceneList();
    clearEditor();
    hideCheckResult();
    await loadPrompts();
}

/** 新增场景 - 打开弹窗 */
function handleAddScene() {
    document.getElementById('scene-modal-title').textContent = '新增场景';
    document.getElementById('scene-modal-name').value = '';
    document.getElementById('scene-modal-desc').value = '';
    document.getElementById('scene-edit-modal').style.display = 'flex';
    setTimeout(() => document.getElementById('scene-modal-name').focus(), 100);
}

/** 关闭场景编辑弹窗 */
function closeSceneModal() {
    document.getElementById('scene-edit-modal').style.display = 'none';
}

/** 提交场景编辑弹窗 */
async function submitSceneModal() {
    const name = document.getElementById('scene-modal-name').value.trim();
    if (!name) {
        showToast('场景名称不能为空', 'warning');
        return;
    }
    const description = document.getElementById('scene-modal-desc').value.trim();
    const btn = document.getElementById('scene-modal-confirm');
    lockBtn(btn, '提交中...');
    try {
        const newScene = await apiPost('/api/scenes', { name, description });
        state.scenes.push(newScene);
        selectScene(newScene.id);
        closeSceneModal();
        showToast('场景创建成功', 'success');
    } catch (e) {
        // apiRequest已处理错误提示
    } finally {
        unlockBtn(btn);
    }
}

// ========== Prompt 列表相关 ==========

/** 加载Prompt列表 */
async function loadPrompts() {
    if (!state.currentSceneId) {
        state.prompts = [];
        renderPromptList();
        return;
    }
    try {
        state.prompts = await apiGet(`/api/prompts?scene_id=${state.currentSceneId}`);
        renderPromptList();
    } catch (e) {
        console.error('加载Prompt列表失败:', e);
        state.prompts = [];
        renderPromptList();
    }
}

/** 渲染Prompt列表 */
function renderPromptList() {
    const container = document.getElementById('prompt-list');
    const countEl = document.getElementById('prompt-count');

    // 更新计数
    countEl.textContent = state.prompts.length ? `${state.prompts.length} 个` : '';

    if (!state.currentSceneId) {
        container.innerHTML = `
            <div class="pm-file-empty">
                <svg class="w-10 h-10 mb-2 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>
                <span>请先选择场景</span>
            </div>`;
        return;
    }

    if (!state.prompts.length) {
        container.innerHTML = `
            <div class="pm-file-empty">
                <svg class="w-10 h-10 mb-2 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 4v16m8-8H4"></path></svg>
                <span>暂无Prompt，点击"新增"创建</span>
            </div>`;
        return;
    }

    container.innerHTML = state.prompts.map(p => {
        const roleTag = p.role_name ? `<span style="display:inline-block; font-size:11px; color:#6b7280; background:#f3f4f6; padding:1px 6px; border-radius:4px; margin-left:6px;">${escapeHtml(p.role_name)}</span>` : '';
        return `
        <div class="pm-file-item ${p.id === state.currentPromptId ? 'pm-file-item--active' : ''}"
             data-prompt-id="${p.id}" onclick="selectPrompt(${p.id})">
            <div class="pm-file-info">
                <div class="pm-file-name" title="${p.name}">${p.name}${roleTag}</div>
                <div class="pm-file-type">${p.file_type || '.prompt'}</div>
            </div>
            <div class="pm-file-actions">
                <button class="pm-file-action-btn" title="编辑" onclick="event.stopPropagation(); selectPrompt(${p.id})">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path></svg>
                </button>
                <button class="pm-file-action-btn pm-file-action-btn--danger" title="删除" onclick="event.stopPropagation(); handleDeletePrompt(${p.id}, '${p.name}')">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                </button>
            </div>
        </div>`;
    }).join('');
}

/** 选中Prompt进行编辑 */
function selectPrompt(promptId) {
    const prompt = state.prompts.find(p => p.id === promptId);
    if (!prompt) return;

    state.currentPromptId = promptId;
    state.isEditing = true;
    state.originalContent = prompt.content;

    // 更新列表选中状态
    renderPromptList();

    // 显示编辑器
    // 显示编辑器
    document.getElementById('editor-placeholder').style.display = 'none';
    document.getElementById('editor-content').style.display = 'block';
    document.getElementById('editor-header').style.display = '';
    document.getElementById('editor-prompt-name').textContent = prompt.name;
    document.getElementById('editor-prompt-type').textContent = prompt.file_type || '.prompt';
    // 角色名字：有值时显示标签和编辑框，无值时只显示编辑框
    const roleTag = document.getElementById('editor-prompt-role-tag');
    const roleInput = document.getElementById('editor-role-name-input');
    if (prompt.role_name) {
        roleTag.textContent = prompt.role_name;
        roleTag.style.display = 'inline-block';
        roleInput.value = prompt.role_name;
    } else {
        roleTag.style.display = 'none';
        roleInput.value = '';
    }
    roleInput.style.display = 'inline-block';
    document.getElementById('editor-content').value = prompt.content;
    document.getElementById('editor-content').disabled = false;

    // 隐藏检查结果
    hideCheckResult();
}

/** 清空编辑器 */
function clearEditor() {
    state.currentPromptId = null;
    state.isEditing = false;
    state.originalContent = '';

    document.getElementById('editor-placeholder').style.display = 'flex';
    document.getElementById('editor-content').style.display = 'none';
    document.getElementById('editor-header').style.display = 'none';
    document.getElementById('editor-content').value = '';
    document.getElementById('editor-content').disabled = true;
    document.getElementById('editor-prompt-role-tag').style.display = 'none';
    document.getElementById('editor-role-name-input').style.display = 'none';
    document.getElementById('editor-role-name-input').value = '';
}

// ========== Prompt CRUD ==========

/** 新增Prompt弹窗 */
function handleAddPrompt() {
    if (!state.currentSceneId) {
        showToast('请先选择场景', 'warning');
        return;
    }
    document.getElementById('new-prompt-name').value = '';
    document.getElementById('new-prompt-role-name').value = '';
    document.getElementById('new-prompt-file-type').value = '.prompt';
    document.getElementById('add-prompt-modal').style.display = 'flex';
    // 自动聚焦
    setTimeout(() => document.getElementById('new-prompt-name').focus(), 100);
}

/** 关闭新增弹窗 */
function closeAddModal() {
    document.getElementById('add-prompt-modal').style.display = 'none';
}

/** 提交新增Prompt */
async function submitNewPrompt() {
    const name = (document.getElementById('new-prompt-name').value || '').trim();
    const roleName = (document.getElementById('new-prompt-role-name').value || '').trim();
    const fileType = document.getElementById('new-prompt-file-type').value;

    if (!name) {
        showToast('请输入Prompt名称', 'warning');
        return;
    }

    const btn = document.querySelector('#add-prompt-modal .btn-primary');
    lockBtn(btn, '创建中...');
    try {
        const newPrompt = await apiPost('/api/prompts', {
            scene_id: state.currentSceneId,
            name: name,
            content: '',
            file_type: fileType,
            role_name: roleName,
        });
        closeAddModal();
        // 刷新列表并选中新Prompt
        await loadPrompts();
        selectPrompt(newPrompt.id);
        showToast(`Prompt '${name}' 创建成功`, 'success');
    } catch (e) {
        // apiRequest已处理错误提示
    } finally {
        unlockBtn(btn);
    }
}

/** 保存Prompt */
async function handleSavePrompt() {
    if (!state.currentPromptId) return;

    const content = document.getElementById('editor-content').value;
    const roleName = (document.getElementById('editor-role-name-input').value || '').trim();
    const btn = document.querySelector('#editor-header .btn-primary');
    lockBtn(btn, '保存中...');
    try {
        await apiPut(`/api/prompts/${state.currentPromptId}`, { content, role_name: roleName });
        state.originalContent = content;
        // 更新本地列表数据
        const prompt = state.prompts.find(p => p.id === state.currentPromptId);
        if (prompt) {
            prompt.content = content;
            prompt.role_name = roleName;
        }
        // 更新角色标签显示
        const roleTag = document.getElementById('editor-prompt-role-tag');
        if (roleName) {
            roleTag.textContent = roleName;
            roleTag.style.display = 'inline-block';
        } else {
            roleTag.style.display = 'none';
        }
        renderPromptList();
        showToast('保存成功', 'success');
    } catch (e) {
        // apiRequest已处理错误提示
    } finally {
        unlockBtn(btn);
    }
}

/** 取消编辑 */
function handleCancelEdit() {
    if (state.currentPromptId) {
        // 恢复原始内容
        document.getElementById('editor-content').value = state.originalContent;
    }
}

/** 删除Prompt */
async function handleDeletePrompt(promptId, promptName) {
    const confirmed = await showConfirm('删除确认', `确定要删除 Prompt "${promptName}" 吗？此操作不可撤销。`);
    if (!confirmed) return;

    try {
        await apiDelete(`/api/prompts/${promptId}`);
        // 如果删除的是当前编辑的Prompt，清空编辑器
        if (state.currentPromptId === promptId) {
            clearEditor();
        }
        await loadPrompts();
        showToast(`Prompt '${promptName}' 已删除`, 'success');
    } catch (e) {
        // apiRequest已处理错误提示
    }
}

// ========== 规则检查 ==========

/** 规则检查 */
async function handleCheckPrompt() {
    if (!state.currentSceneId) {
        showToast('请先选择场景', 'warning');
        return;
    }

    // 获取当前编辑器内容，如果没有选中Prompt则检查所有Prompt
    let checkContent = '';
    if (state.currentPromptId) {
        checkContent = document.getElementById('editor-content').value;
    } else if (state.prompts.length > 0) {
        // 没有选中单个Prompt时，拼接所有Prompt内容进行检查
        checkContent = state.prompts.map(p => `=== ${p.name} ===\n${p.content}`).join('\n\n');
    } else {
        showToast('当前场景下没有Prompt可检查', 'warning');
        return;
    }

    try {
        const result = await apiPost('/api/prompts/check', {
            content: checkContent,
            scene_id: state.currentSceneId,
        });
        renderCheckResult(result);
    } catch (e) {
        // apiRequest已处理错误提示
    }
}

/** 渲染检查结果 */
function renderCheckResult(result) {
    const area = document.getElementById('check-result-area');
    let html = '';

    if (result.valid) {
        html += `<div class="pm-check-item pm-check-item--pass">
            <svg class="w-4 h-4 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>
            <span>规则检查通过：所有占位符均已包含</span>
        </div>`;
    } else {
        html += `<div class="pm-check-item pm-check-item--fail">
            <svg class="w-4 h-4 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
            <span>规则检查未通过：缺少占位符 {${result.missing_fields.join('}、{')}}}</span>
        </div>`;
    }

    if (result.warnings && result.warnings.length > 0) {
        result.warnings.forEach(w => {
            html += `<div class="pm-check-item pm-check-item--warn">
                <svg class="w-4 h-4 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"></path></svg>
                <span>${w}</span>
            </div>`;
        });
    }

    area.innerHTML = html;
    area.style.display = 'block';
}

/** 隐藏检查结果 */
function hideCheckResult() {
    document.getElementById('check-result-area').style.display = 'none';
}

// ========== 同步本地 ==========

/** 同步到本地文件 */
async function handleSyncLocal() {
    if (!state.currentSceneId) {
        showToast('请先选择场景', 'warning');
        return;
    }

    const sceneName = state.scenes.find(s => s.id === state.currentSceneId)?.name || '';
    const confirmed = await showConfirm(
        '同步到本地',
        `确定将场景「${sceneName}」的所有Prompt同步到本地文件吗？以数据库数据为准，将覆盖本地已有文件。`
    );
    if (!confirmed) return;

    const btn = document.getElementById('btn-sync-local');
    lockBtn(btn, '同步中...');
    try {
        showLoading('正在同步...');
        const result = await apiPost('/api/prompts/sync-local', { scene_id: state.currentSceneId });
        hideLoading();

        let msg = `同步完成：${result.synced_count} 个文件已写入`;
        if (result.deleted_files && result.deleted_files.length > 0) {
            msg += `，${result.deleted_files.length} 个文件已清理`;
        }
        showToast(msg, 'success');
    } catch (e) {
        hideLoading();
        // apiRequest已处理错误提示
    } finally {
        unlockBtn(btn);
    }
}

// ========== 键盘快捷键 ==========

function bindKeyboardShortcuts() {
    // 新增弹窗中回车提交
    document.getElementById('new-prompt-name').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            submitNewPrompt();
        }
    });

    // 点击弹窗背景关闭
    document.getElementById('add-prompt-modal').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) {
            closeAddModal();
        }
    });

    // 场景编辑弹窗事件
    document.getElementById('scene-modal-cancel').addEventListener('click', closeSceneModal);
    document.getElementById('scene-modal-confirm').addEventListener('click', submitSceneModal);
    document.getElementById('scene-edit-modal').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) {
            closeSceneModal();
        }
    });
    document.getElementById('scene-modal-name').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            submitSceneModal();
        }
    });

    // Ctrl+S 保存
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            if (state.isEditing && state.currentPromptId) {
                handleSavePrompt();
            }
        }
    });

    // Escape 关闭弹窗
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const addPromptModal = document.getElementById('add-prompt-modal');
            if (addPromptModal.style.display === 'flex') {
                closeAddModal();
            }
            const sceneModal = document.getElementById('scene-edit-modal');
            if (sceneModal.style.display === 'flex') {
                closeSceneModal();
            }
        }
    });
}

// ========== 工具函数 ==========

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
