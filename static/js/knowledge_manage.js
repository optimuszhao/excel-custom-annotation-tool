/**
 * 数据飞轮 - 知识管理页面逻辑
 * 场景切换、文件列表、编辑保存、新增、删除、同步到本地
 */

// ========== 页面状态 ==========
let scenes = [];               // 场景列表
let currentSceneId = null;     // 当前选中的场景ID
let knowledgeFiles = [];       // 当前场景的知识文件列表
let currentFileId = null;      // 当前选中的知识文件ID
let currentFileData = null;    // 当前选中的知识文件完整数据
let isContentModified = false; // 编辑内容是否已修改

// ========== DOM 引用 ==========
const sceneListEl = document.getElementById('scene-list');
const sceneAddBtn = document.getElementById('scene-add-btn');
const fileListEl = document.getElementById('file-list');
const fileListTitle = document.getElementById('file-list-title');
const fileAddBtn = document.getElementById('file-add-btn');
const editorEmpty = document.getElementById('editor-empty');
const editorContent = document.getElementById('editor-content');
const editorTitle = document.getElementById('editor-title');
const editorTextarea = document.getElementById('editor-textarea');
const editorSaveBtn = document.getElementById('editor-save-btn');
const editorCancelBtn = document.getElementById('editor-cancel-btn');
const syncLocalBtn = document.getElementById('sync-local-btn');

// 新增文件弹窗
const addFileModal = document.getElementById('add-file-modal');
const modalFileName = document.getElementById('modal-file-name');
const modalFileType = document.getElementById('modal-file-type');
const modalCancelBtn = document.getElementById('modal-cancel-btn');
const modalConfirmBtn = document.getElementById('modal-confirm-btn');

// 新增场景弹窗
const addSceneModal = document.getElementById('add-scene-modal');
const sceneModalName = document.getElementById('scene-modal-name');
const sceneModalDesc = document.getElementById('scene-modal-desc');
const sceneModalCancel = document.getElementById('scene-modal-cancel');
const sceneModalConfirm = document.getElementById('scene-modal-confirm');

// ========== 初始化 ==========
document.addEventListener('DOMContentLoaded', async () => {
    await loadScenes();
    bindEvents();
});

// ========== 场景列表 ==========
async function loadScenes() {
    try {
        scenes = await apiGet('/api/scenes');
    } catch (e) {
        scenes = [];
    }
    renderSceneList();
    // 优先选中URL参数中的场景
    const urlSceneId = getUrlParam('scene_id');
    if (urlSceneId && scenes.find(s => s.id == urlSceneId)) {
        selectScene(parseInt(urlSceneId));
    } else if (scenes.length > 0) {
        selectScene(scenes[0].id);
    } else {
        currentSceneId = null;
        showEmptyState();
    }
}

function renderSceneList() {
    if (!sceneListEl) return;
    let html = '';
    scenes.forEach(scene => {
        const isActive = scene.id === currentSceneId;
        html += `
            <div class="knowledge-scene-item ${isActive ? 'knowledge-scene-item--active' : ''}" data-scene-id="${scene.id}">
                <span class="knowledge-scene-item__name" title="${scene.name}">${scene.name}</span>
            </div>
        `;
    });
    sceneListEl.innerHTML = html;
    // 绑定场景项点击事件
    sceneListEl.querySelectorAll('.knowledge-scene-item').forEach(item => {
        item.addEventListener('click', () => selectScene(parseInt(item.dataset.sceneId)));
    });
}

async function selectScene(sceneId) {
    // 如果有未保存的内容，提示用户
    if (isContentModified && currentFileId) {
        const confirmed = await showConfirm('未保存的修改', '当前文件内容已修改但未保存，是否切换场景？未保存的修改将丢失。');
        if (!confirmed) return;
    }
    currentSceneId = sceneId;
    currentFileId = null;
    currentFileData = null;
    isContentModified = false;
    setUrlParam('scene_id', sceneId);
    renderSceneList();
    showFileList();
    await loadKnowledgeFiles(sceneId);
}

// ========== 知识文件列表 ==========
async function loadKnowledgeFiles(sceneId) {
    if (!sceneId) {
        knowledgeFiles = [];
        renderFileList();
        return;
    }
    try {
        knowledgeFiles = await apiGet(`/api/knowledge?scene_id=${sceneId}`);
    } catch (e) {
        knowledgeFiles = [];
    }
    renderFileList();
    // 更新文件列表标题
    const scene = scenes.find(s => s.id === sceneId);
    fileListTitle.textContent = scene ? `${scene.name} — 知识文件` : '知识文件';
    fileAddBtn.style.display = 'inline-flex';
    // 默认选中第一个文件
    if (knowledgeFiles.length > 0) {
        selectFile(knowledgeFiles[0].id);
    } else {
        showEmptyState();
    }
}

function renderFileList() {
    if (!fileListEl) return;
    if (knowledgeFiles.length === 0 && currentSceneId) {
        fileListEl.innerHTML = `
            <div class="knowledge-empty" style="padding: 2rem 0;">
                <p style="font-size: 13px;">暂无知识文件</p>
            </div>
        `;
        return;
    }
    if (!currentSceneId) {
        fileListEl.innerHTML = '';
        return;
    }
    let html = '';
    knowledgeFiles.forEach(file => {
        const isActive = file.id === currentFileId;
        const typeClass = file.file_type === '.json' ? 'json' : file.file_type === '.jsonl' ? 'jsonl' : 'txt';
        const typeLabel = file.file_type || '.txt';
        html += `
            <div class="knowledge-file-item ${isActive ? 'knowledge-file-item--active' : ''}" data-file-id="${file.id}">
                <div class="knowledge-file-item__icon knowledge-file-item__icon--${typeClass}">${typeLabel.replace('.', '').toUpperCase()}</div>
                <div class="knowledge-file-item__info">
                    <div class="knowledge-file-item__name">${file.name}</div>
                    <div class="knowledge-file-item__meta">${formatDateTime(file.updated_at)}</div>
                </div>
                <span class="knowledge-file-item__actions">
                    <button class="knowledge-file-item__btn knowledge-file-item__btn--danger file-delete-btn" data-file-id="${file.id}" title="删除">
                        <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                    </button>
                </span>
            </div>
        `;
    });
    fileListEl.innerHTML = html;

    // 绑定文件项点击事件
    fileListEl.querySelectorAll('.knowledge-file-item').forEach(item => {
        item.addEventListener('click', (e) => {
            if (e.target.closest('.file-delete-btn')) return;
            selectFile(parseInt(item.dataset.fileId));
        });
    });

    // 绑定删除按钮
    fileListEl.querySelectorAll('.file-delete-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const fileId = parseInt(btn.dataset.fileId);
            const file = knowledgeFiles.find(f => f.id === fileId);
            if (!file) return;
            const confirmed = await showConfirm('删除知识文件', `确定要删除知识文件「${file.name}」吗？此操作不可恢复。`);
            if (!confirmed) return;
            try {
                await apiDelete(`/api/knowledge/${fileId}`);
                showToast('知识文件已删除', 'success');
                // 如果删除的是当前编辑的文件，清空编辑区
                if (currentFileId === fileId) {
                    currentFileId = null;
                    currentFileData = null;
                    isContentModified = false;
                    showEmptyState();
                }
                await loadKnowledgeFiles(currentSceneId);
            } catch (err) {
                // apiDelete 已通过 showToast 展示错误
            }
        });
    });
}

async function selectFile(fileId) {
    // 如果有未保存的内容，提示用户
    if (isContentModified && currentFileId && currentFileId !== fileId) {
        const confirmed = await showConfirm('未保存的修改', '当前文件内容已修改但未保存，是否切换文件？未保存的修改将丢失。');
        if (!confirmed) return;
    }
    currentFileId = fileId;
    currentFileData = knowledgeFiles.find(f => f.id === fileId) || null;
    isContentModified = false;
    renderFileList();
    showEditor();
}

// ========== 编辑区 ==========
function showEmptyState() {
    editorEmpty.style.display = 'flex';
    editorContent.style.display = 'none';
}

function showEditor() {
    if (!currentFileData) {
        showEmptyState();
        return;
    }
    editorEmpty.style.display = 'none';
    editorContent.style.display = 'flex';
    editorTitle.textContent = `${currentFileData.name} (${currentFileData.file_type || '.txt'})`;
    editorTextarea.value = currentFileData.content || '';
    isContentModified = false;
}

function showFileList() {
    fileAddBtn.style.display = currentSceneId ? 'inline-flex' : 'none';
}

// ========== 保存知识文件 ==========
async function saveKnowledgeFile() {
    if (!currentFileId || !currentFileData) {
        showToast('请先选择知识文件', 'warning');
        return;
    }
    const content = editorTextarea.value;
    editorSaveBtn.disabled = true;
    try {
        await apiPut(`/api/knowledge/${currentFileId}`, { content });
        showToast('知识文件已保存', 'success');
        isContentModified = false;
        // 刷新文件列表
        await loadKnowledgeFiles(currentSceneId);
        // 重新选中当前文件
        currentFileId = currentFileId;
        currentFileData = knowledgeFiles.find(f => f.id === currentFileId) || null;
    } catch (err) {
        // apiPut 已通过 showToast 展示错误
    } finally {
        editorSaveBtn.disabled = false;
    }
}

// ========== 同步到本地 ==========
async function syncToLocal() {
    if (!currentSceneId) {
        showToast('请先选择场景', 'warning');
        return;
    }
    syncLocalBtn.disabled = true;
    try {
        const result = await apiPost('/api/knowledge/sync-local', { scene_id: currentSceneId });
        showToast(result.message || '同步完成', 'success');
    } catch (err) {
        // apiPost 已通过 showToast 展示错误
    } finally {
        syncLocalBtn.disabled = false;
    }
}

// ========== 新增知识文件 ==========
function openAddFileModal() {
    if (!currentSceneId) {
        showToast('请先选择场景', 'warning');
        return;
    }
    modalFileName.value = '';
    modalFileType.value = '.txt';
    addFileModal.style.display = 'flex';
}

function closeAddFileModal() {
    addFileModal.style.display = 'none';
}

async function submitAddFileModal() {
    const name = modalFileName.value.trim();
    const fileType = modalFileType.value;
    if (!name) {
        showToast('请输入知识文件名称', 'warning');
        return;
    }
    try {
        await apiPost('/api/knowledge', {
            scene_id: currentSceneId,
            name: name,
            content: '',
            file_type: fileType,
        });
        showToast('知识文件已创建', 'success');
        closeAddFileModal();
        await loadKnowledgeFiles(currentSceneId);
    } catch (err) {
        // apiPost 已通过 showToast 展示错误
    }
}

// ========== 新增场景 ==========
function openAddSceneModal() {
    sceneModalName.value = '';
    sceneModalDesc.value = '';
    addSceneModal.style.display = 'flex';
    setTimeout(() => sceneModalName.focus(), 100);
}

function closeAddSceneModal() {
    addSceneModal.style.display = 'none';
}

async function submitAddSceneModal() {
    const name = sceneModalName.value.trim();
    if (!name) {
        showToast('场景名称不能为空', 'warning');
        return;
    }
    const description = sceneModalDesc.value.trim();
    try {
        const newScene = await apiPost('/api/scenes', { name, description });
        showToast('场景已创建', 'success');
        closeAddSceneModal();
        await loadScenes();
        selectScene(newScene.id);
    } catch (err) {
        // apiPost 已通过 showToast 展示错误
    }
}

// ========== 事件绑定 ==========
function bindEvents() {
    // 场景新增按钮
    sceneAddBtn.addEventListener('click', openAddSceneModal);

    // 文件新增按钮
    fileAddBtn.addEventListener('click', openAddFileModal);

    // 新增文件弹窗
    modalCancelBtn.addEventListener('click', closeAddFileModal);
    modalConfirmBtn.addEventListener('click', submitAddFileModal);
    addFileModal.addEventListener('click', (e) => {
        if (e.target === addFileModal) closeAddFileModal();
    });

    // 新增场景弹窗
    sceneModalCancel.addEventListener('click', closeAddSceneModal);
    sceneModalConfirm.addEventListener('click', submitAddSceneModal);
    addSceneModal.addEventListener('click', (e) => {
        if (e.target === addSceneModal) closeAddSceneModal();
    });
    sceneModalName.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            submitAddSceneModal();
        }
    });

    // 编辑区保存
    editorSaveBtn.addEventListener('click', saveKnowledgeFile);

    // 编辑区取消（还原内容）
    editorCancelBtn.addEventListener('click', () => {
        if (currentFileData) {
            editorTextarea.value = currentFileData.content || '';
            isContentModified = false;
            showToast('内容已还原', 'info');
        }
    });

    // 编辑区内容变化检测
    editorTextarea.addEventListener('input', () => {
        isContentModified = true;
    });

    // 同步到本地
    syncLocalBtn.addEventListener('click', syncToLocal);

    // 键盘快捷键：Ctrl+S 保存
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            if (currentFileId) {
                saveKnowledgeFile();
            }
        }
        // ESC 关闭弹窗
        if (e.key === 'Escape') {
            if (addFileModal.style.display === 'flex') {
                closeAddFileModal();
            }
            if (addSceneModal.style.display === 'flex') {
                closeAddSceneModal();
            }
        }
    });
}
