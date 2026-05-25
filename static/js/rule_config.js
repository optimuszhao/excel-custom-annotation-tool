/**
 * 数据飞轮 - 规则配置页面逻辑
 * 场景管理 + JSON 编辑器
 */

// ========== 默认 JSON 模板 ==========
const DEFAULT_RULE_TEMPLATE = {
    excel_fields: ["chat_question", "chat_answer", "api调用记录1", "api调用记录2"],
    annotate_fields: ["chat_question", "chat_answer", "api调用记录1"],
    answer_field: "人工标注答案",
    result_label_field: "标注结果",
    positive_value: "是",
    negative_value: "否"
};

// ========== 页面状态 ==========
let scenes = [];           // 场景列表
let currentSceneId = null; // 当前选中的场景ID
let editingSceneId = null; // 正在编辑的场景ID（null=新增）

// ========== DOM 引用 ==========
const sceneListEl = document.getElementById('scene-list');
const sceneAddBtn = document.getElementById('scene-add-btn');
const ruleEmptyEl = document.getElementById('rule-empty');
const ruleFormWrapper = document.getElementById('rule-form-wrapper');
const ruleSceneTitle = document.getElementById('rule-scene-title');
const ruleSceneDesc = document.getElementById('rule-scene-desc');
const saveRuleBtn = document.getElementById('save-rule-btn');
const jsonEditor = document.getElementById('rule-json-editor');
const jsonStatus = document.getElementById('json-status');

// 场景编辑弹窗
const sceneEditModal = document.getElementById('scene-edit-modal');
const sceneModalTitle = document.getElementById('scene-modal-title');
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
            <div class="rule-scene-item ${isActive ? 'rule-scene-item--active' : ''}" data-scene-id="${scene.id}">
                <span class="rule-scene-item__name" title="${scene.name}">${scene.name}</span>
                <span class="rule-scene-item__actions">
                    <button class="rule-scene-item__btn scene-edit-btn" data-scene-id="${scene.id}" title="编辑">
                        <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path></svg>
                    </button>
                    <button class="rule-scene-item__btn rule-scene-item__btn--danger scene-delete-btn" data-scene-id="${scene.id}" title="删除">
                        <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                    </button>
                </span>
            </div>
        `;
    });
    sceneListEl.innerHTML = html;

    sceneListEl.querySelectorAll('.rule-scene-item').forEach(item => {
        item.addEventListener('click', (e) => {
            if (e.target.closest('.scene-edit-btn') || e.target.closest('.scene-delete-btn')) return;
            selectScene(parseInt(item.dataset.sceneId));
        });
    });

    sceneListEl.querySelectorAll('.scene-edit-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            openEditSceneModal(parseInt(btn.dataset.sceneId));
        });
    });

    sceneListEl.querySelectorAll('.scene-delete-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const sceneId = parseInt(btn.dataset.sceneId);
            const scene = scenes.find(s => s.id === sceneId);
            if (!scene) return;
            const confirmed = await showConfirm('删除场景', `确定要删除场景「${scene.name}」吗？删除前需确保无关联资源。`);
            if (!confirmed) return;
            try {
                await apiDelete(`/api/scenes/${sceneId}`);
                showToast('场景已删除', 'success');
                scenes = scenes.filter(s => s.id !== sceneId);
                if (currentSceneId === sceneId) {
                    if (scenes.length > 0) {
                        selectScene(scenes[0].id);
                    } else {
                        currentSceneId = null;
                        showEmptyState();
                    }
                }
                renderSceneList();
            } catch (err) {
                // apiDelete 已通过 showToast 展示错误
            }
        });
    });
}

function selectScene(sceneId) {
    currentSceneId = sceneId;
    setUrlParam('scene_id', sceneId);
    renderSceneList();
    showRuleForm();
    loadRuleConfig(sceneId);
}

// ========== 空状态 / 编辑器切换 ==========
function showEmptyState() {
    ruleEmptyEl.style.display = 'flex';
    ruleFormWrapper.style.display = 'none';
}

function showRuleForm() {
    ruleEmptyEl.style.display = 'none';
    ruleFormWrapper.style.display = 'flex';
    const scene = scenes.find(s => s.id === currentSceneId);
    if (scene) {
        ruleSceneTitle.textContent = `${scene.name} — 规则配置`;
        ruleSceneDesc.textContent = scene.description || '直接编辑 JSON 配置规则，保存后同步写入数据库与本地文件';
    }
    clearStatus();
}

// ========== 规则配置加载 ==========
async function loadRuleConfig(sceneId) {
    try {
        const data = await apiGet(`/api/rules/${sceneId}`);
        // 去掉 scene_id 字段，只保留规则字段
        const { scene_id, ...ruleFields } = data;
        // 若所有字段均为空，显示默认模板
        const isEmpty = !ruleFields.answer_field && !ruleFields.result_label_field
            && (!ruleFields.excel_fields || ruleFields.excel_fields.length === 0)
            && (!ruleFields.annotate_fields || ruleFields.annotate_fields.length === 0);
        jsonEditor.value = JSON.stringify(isEmpty ? DEFAULT_RULE_TEMPLATE : ruleFields, null, 2);
    } catch (e) {
        jsonEditor.value = JSON.stringify(DEFAULT_RULE_TEMPLATE, null, 2);
    }
    clearStatus();
}

// ========== 状态提示 ==========
function setStatus(msg, type) {
    // type: 'error' | 'success' | 'warn'
    jsonStatus.textContent = msg;
    jsonStatus.className = 'json-status';
    if (type) jsonStatus.classList.add(`json-status--${type}`);
}

function clearStatus() {
    jsonStatus.textContent = '';
    jsonStatus.className = 'json-status';
}

// ========== 实时 JSON 格式校验 ==========
function validateJson(text) {
    try {
        JSON.parse(text);
        return { valid: true };
    } catch (e) {
        return { valid: false, message: e.message };
    }
}

// ========== 保存规则配置 ==========
async function saveRuleConfig() {
    if (!currentSceneId) {
        showToast('请先选择场景', 'warning');
        return;
    }
    const rawText = jsonEditor.value.trim();
    if (!rawText) {
        setStatus('内容不能为空', 'error');
        return;
    }
    const check = validateJson(rawText);
    if (!check.valid) {
        setStatus(`JSON 格式不合法，请检查：${check.message}`, 'error');
        return;
    }

    lockBtn(saveRuleBtn, '保存中...');
    clearStatus();
    try {
        await apiPut(`/api/rules/${currentSceneId}`, { json_text: rawText });
        setStatus('规则保存成功，已同步到本地文件', 'success');
        showToast('规则配置已保存', 'success');
    } catch (err) {
        setStatus('保存失败，请检查后端日志', 'error');
    } finally {
        unlockBtn(saveRuleBtn);
    }
}

// ========== 场景编辑弹窗 ==========
function openAddSceneModal() {
    editingSceneId = null;
    sceneModalTitle.textContent = '新增场景';
    sceneModalName.value = '';
    sceneModalDesc.value = '';
    sceneEditModal.style.display = 'flex';
}

function openEditSceneModal(sceneId) {
    const scene = scenes.find(s => s.id === sceneId);
    if (!scene) return;
    editingSceneId = sceneId;
    sceneModalTitle.textContent = '编辑场景';
    sceneModalName.value = scene.name;
    sceneModalDesc.value = scene.description || '';
    sceneEditModal.style.display = 'flex';
}

function closeSceneModal() {
    sceneEditModal.style.display = 'none';
    editingSceneId = null;
}

async function submitSceneModal() {
    const name = sceneModalName.value.trim();
    if (!name) {
        showToast('场景名称不能为空', 'warning');
        return;
    }
    const description = sceneModalDesc.value.trim();
    const btn = sceneModalConfirm;
    lockBtn(btn, '提交中...');
    try {
        if (editingSceneId) {
            await apiPut(`/api/scenes/${editingSceneId}`, { name, description });
            showToast('场景已更新', 'success');
        } else {
            const newScene = await apiPost('/api/scenes', { name, description });
            scenes.push(newScene);
            showToast('场景已创建', 'success');
        }
        await loadScenes();
        closeSceneModal();
    } catch (err) {
        // apiPut/apiPost 已通过 showToast 展示错误
    } finally {
        unlockBtn(btn);
    }
}

// ========== 事件绑定 ==========
function bindEvents() {
    sceneAddBtn.addEventListener('click', openAddSceneModal);
    saveRuleBtn.addEventListener('click', saveRuleConfig);

    // 实时校验 JSON 格式
    jsonEditor.addEventListener('input', () => {
        const text = jsonEditor.value.trim();
        if (!text) {
            clearStatus();
            return;
        }
        const check = validateJson(text);
        if (!check.valid) {
            setStatus(`JSON 格式错误：${check.message}`, 'error');
        } else {
            clearStatus();
        }
    });

    // Tab 键插入4个空格，方便编辑 JSON
    jsonEditor.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
            e.preventDefault();
            const start = jsonEditor.selectionStart;
            const end = jsonEditor.selectionEnd;
            jsonEditor.value = jsonEditor.value.substring(0, start) + '    ' + jsonEditor.value.substring(end);
            jsonEditor.selectionStart = jsonEditor.selectionEnd = start + 4;
        }
    });

    // 场景编辑弹窗
    sceneModalCancel.addEventListener('click', closeSceneModal);
    sceneModalConfirm.addEventListener('click', submitSceneModal);
    sceneEditModal.addEventListener('click', (e) => {
        if (e.target === sceneEditModal) closeSceneModal();
    });

    // ESC 关闭弹窗
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && sceneEditModal.style.display === 'flex') {
            closeSceneModal();
        }
    });
}
