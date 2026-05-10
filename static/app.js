// ============================================================
// 数据飞轮 - Prompt标注调试台 前端逻辑
// ============================================================

// ==================== 全局状态 ====================
const state = {
    currentPage: 1,
    pageSize: 10,
    totalPages: 1,
    total: 0,
    search: '',
    filter: '',
    sortBy: '',
    sortDir: 'asc',
    currentModel: '',
    models: [],
    fields: [],
    uploadedFilename: '',
    uploadedColumns: [],
    prompts: {},
    knowledge: {},
    rows: [],
    selectedRowIds: new Set(),
    selectedCombos: new Set(),
    columnWidths: JSON.parse(localStorage.getItem('columnWidthsV2') || '{}'),
    autoColumnWidths: {},
    hiddenColumns: JSON.parse(localStorage.getItem('hiddenColumns') || '[]'),
    dataColumnVisibilityOverrides: JSON.parse(localStorage.getItem('dataColumnVisibilityOverridesV1') || '{}'),
    comboConcurrency: JSON.parse(localStorage.getItem('comboConcurrency') || '{}'),
    comboTimers: {},
    settings: {
        default_model: '',
        default_strategy: '',
        default_concurrency: 1
    },
    taskPollTimer: null,
    activeTaskSnapshot: {},
    // rule.json 配置
    rule: {
        excel_fields: [],
        annotate_fields: [],
        answer_field: '',
        result_label_field: 'label'
    },
    // 维护区域状态
    currentPromptFile: '',
    currentKnowledgeFile: '',
    currentModelFile: '',
    // 搜索防抖
    _searchTimer: null,
    // 标注策略
    currentStrategy: '',
    strategies: [],
    annotationQueue: {
        active: false,
        done: 0,
        total: 0,
        target: ''
    },
    comboQueues: {},
    nightAutoAnnotateTimer: null,
    busyCount: 0,
    loadingRows: false,
    clearSlide: {
        dragging: false,
        confirmed: false
    },
    pendingBulkAction: '',
    pendingBulkIds: [],
    pendingCancelTaskCount: 0,
    rangeSelection: {
        start: 1,
        end: 1,
        dragging: '',
        total: 0,
        touched: false
    }
};

const statHelpText = {
    total: '当前已入库的数据总行数。作为所有统计指标的整体样本规模。',
    annotated: '当前模型和方案下已有标注结果的数据行数。公式：TP + FN + FP + TN。',
    tp: 'TP：人工答案为“是”，模型也判为“是”的数量。',
    fn: 'FN：人工答案为“是”，模型判为“否”的数量。',
    fp: 'FP：人工答案为“否”，模型判为“是”的数量。',
    tn: 'TN：人工答案为“否”，模型也判为“否”的数量。',
    accuracy: '模型整体判断正确的比例。公式：(TP + TN) / (TP + FN + FP + TN)。',
    positive_recall: '正确查全率：人工答案为“是”的样本中，被模型判为“是”的比例。公式：TP / (TP + FN)。',
    negative_recall: '错误查全率：人工答案为“否”的样本中，被模型判为“否”的比例。公式：TN / (TN + FP)。',
    positive_precision: '正确查准率：模型判为“是”的样本中，人工答案也为“是”的比例。公式：TP / (TP + FP)。',
    negative_precision: '错误查准率：模型判为“否”的样本中，人工答案也为“否”的比例。公式：TN / (TN + FN)。',
    f1_score: 'F1 Score：综合正确查准率和正确查全率的调和平均值。公式：2TP / (2TP + FP + FN)。',
    task_pending: '当前组合处于 pending 状态的任务数量。',
    task_running: '当前组合处于 running 状态的任务数量。',
    task_success: '当前组合处于 success 状态的任务数量。',
    task_failed: '当前组合处于 failed 状态的任务数量。',
    task_cancelled: '当前组合处于 cancelled 状态的任务数量。'
};

// ==================== 工具函数 ====================
function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.3s';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

async function api(url, options = {}) {
    try {
        const resp = await fetch(url, options);
        if (!resp.ok) {
            const errText = await resp.text();
            throw new Error(errText || `HTTP ${resp.status}`);
        }
        const contentType = resp.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
            return await resp.json();
        }
        return resp;
    } catch (e) {
        showToast(`请求失败: ${e.message}`, 'error');
        throw e;
    }
}

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    const s = String(str);
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
}

function copyToClipboard(text) {
    navigator.clipboard.writeText(String(text)).then(() => {
        showToast('已复制到剪贴板');
    }).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = String(text);
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        showToast('已复制到剪贴板');
    });
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function setTopControlsDisabled(disabled) {
    document.querySelectorAll('.top-control').forEach(el => {
        el.disabled = disabled;
    });
}

function showGlobalLoading(text = '加载中...') {
    state.busyCount += 1;
    const overlay = document.getElementById('appLoading');
    const textEl = document.getElementById('appLoadingText');
    if (textEl) textEl.textContent = text;
    if (overlay) overlay.classList.remove('hidden');
    setTopControlsDisabled(true);
}

function hideGlobalLoading() {
    state.busyCount = Math.max(0, state.busyCount - 1);
    if (state.busyCount > 0) return;
    const overlay = document.getElementById('appLoading');
    if (overlay) overlay.classList.add('hidden');
    setTopControlsDisabled(false);
}

function setBulkAnnotateStatus(text) {
    const el = document.getElementById('bulkAnnotateStatus');
    const btn = document.getElementById('annotateAllBtn');
    if (el) {
        el.innerHTML = text ? `<span class="loading-spinner"></span><span>${escapeHtml(text)}</span>` : '';
        el.classList.toggle('hidden', !text);
    }
    if (btn) btn.disabled = !!text;
}

function formatPercent(val) {
    if (val === null || val === undefined || isNaN(val)) return '-';
    return (val * 100).toFixed(1) + '%';
}

function calcF1Score(tp, fp, fn) {
    const tpNum = Number(tp || 0);
    const fpNum = Number(fp || 0);
    const fnNum = Number(fn || 0);
    const denominator = (2 * tpNum) + fpNum + fnNum;
    if (denominator <= 0) return 0;
    return (2 * tpNum) / denominator;
}

function getOverviewValueClass(label) {
    const mapping = {
        '已标注/数据量': 'overview-value-blue',
        '总量': 'overview-value-slate',
        '已标注': 'overview-value-blue',
        '算法准确率': 'overview-value-indigo',
        '正确查全率': 'overview-value-emerald',
        '错误查全率': 'overview-value-amber',
        '正确查准率': 'overview-value-cyan',
        '错误查准率': 'overview-value-orange',
        'F1 Score': 'overview-value-violet',
        'TP': 'overview-value-emerald',
        'FN': 'overview-value-amber',
        'FP': 'overview-value-rose',
        'TN': 'overview-value-sky',
        '排队中': 'overview-value-amber',
        '执行中': 'overview-value-blue',
        '成功': 'overview-value-emerald',
        '失败': 'overview-value-rose'
    };
    return mapping[label] || 'overview-value-slate';
}

function getStatsToneClass(label) {
    const mapping = {
        '总量': 'stats-tone-slate',
        '已标注': 'stats-tone-blue',
        '算法准确率': 'stats-tone-indigo',
        '正确查全率': 'stats-tone-emerald',
        '错误查全率': 'stats-tone-amber',
        '正确查准率': 'stats-tone-cyan',
        '错误查准率': 'stats-tone-orange',
        'F1 Score': 'stats-tone-violet',
        'TP': 'stats-tone-emerald',
        'FN': 'stats-tone-amber',
        'FP': 'stats-tone-rose',
        'TN': 'stats-tone-sky',
        '排队中': 'stats-tone-amber',
        '执行中': 'stats-tone-blue',
        '成功': 'stats-tone-emerald',
        '失败': 'stats-tone-rose'
    };
    return mapping[label] || 'stats-tone-slate';
}

function clampRate(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    return Math.max(0, Math.min(1, numeric));
}

function renderOverviewMetricCard(label, value, tooltip, isPercent = true) {
    return `<div class="overview-stat-card metric-help" data-tooltip="${escapeHtml(tooltip || '')}">
        <span class="overview-metric-label">${escapeHtml(label)}</span>
        <strong class="overview-metric-value ${getOverviewValueClass(label)}">${escapeHtml(isPercent ? formatPercent(value) : value)}</strong>
    </div>`;
}

function renderOverviewMetricsCard(data, f1Score, hasData) {
    const metrics = [
        ['已标注/数据量', `${data.annotated || 0}/${data.total || 0}`, `${statHelpText.annotated}\n${statHelpText.total}`, false],
        ['算法准确率', data.accuracy, statHelpText.accuracy],
        ['正确查全率', data.positive_recall, statHelpText.positive_recall],
        ['错误查全率', data.negative_recall, statHelpText.negative_recall],
        ['正确查准率', data.positive_precision, statHelpText.positive_precision],
        ['错误查准率', data.negative_precision, statHelpText.negative_precision],
        ['F1 Score', f1Score, statHelpText.f1_score],
    ];
    const metricGrid = hasData
        ? metrics.map(([label, value, tooltip, isPercent = true]) => (
            renderOverviewMetricCard(label, value, tooltip, isPercent)
        )).join('')
        : `<div class="overview-empty-state">
            <div class="overview-empty-title">暂无统计数据</div>
            <div class="overview-empty-text">上传并标注数据后，这里会展示当前组合的核心评估指标。</div>
        </div>`;

    return `<section class="overview-strip-group overview-strip-metrics">
        ${metricGrid}
    </section>`;
}

function renderConfusionMatrix(tp, fn, fp, tn) {
    return `<section class="overview-strip-group overview-strip-block">
        <div class="overview-strip-grid overview-strip-grid-four" aria-label="匹配类型">
            <div class="overview-strip-mini metric-help" data-tooltip="TP：预测正确且答案正确">
                <span class="overview-matrix-label">TP</span>
                <strong class="overview-matrix-value overview-value-emerald">${escapeHtml(tp)}</strong>
            </div>
            <div class="overview-strip-mini metric-help" data-tooltip="FN：漏判为错误">
                <span class="overview-matrix-label">FN</span>
                <strong class="overview-matrix-value overview-value-amber">${escapeHtml(fn)}</strong>
            </div>
            <div class="overview-strip-mini metric-help" data-tooltip="FP：误判为正确">
                <span class="overview-matrix-label">FP</span>
                <strong class="overview-matrix-value overview-value-rose">${escapeHtml(fp)}</strong>
            </div>
            <div class="overview-strip-mini metric-help" data-tooltip="TN：预测错误且答案错误">
                <span class="overview-matrix-label">TN</span>
                <strong class="overview-matrix-value overview-value-sky">${escapeHtml(tn)}</strong>
            </div>
        </div>
    </section>`;
}

function renderTaskStatusCard(taskSummary) {
    const items = [
        ['排队中', taskSummary.pending || 0, statHelpText.task_pending],
        ['执行中', taskSummary.running || 0, statHelpText.task_running],
        ['成功', taskSummary.success || 0, statHelpText.task_success],
        ['失败', taskSummary.failed || 0, statHelpText.task_failed],
    ];
    return `<section class="overview-strip-group overview-strip-block">
        <div class="overview-strip-grid overview-strip-grid-four" aria-label="任务状态">
            ${items.map(([label, value, tooltip]) => `
                <div class="overview-strip-mini metric-help" data-tooltip="${escapeHtml(tooltip || '')}">
                    <span class="overview-task-label">${escapeHtml(label)}</span>
                    <strong class="overview-task-value ${getOverviewValueClass(label)}">${escapeHtml(value)}</strong>
                </div>
            `).join('')}
        </div>
    </section>`;
}

function renderStatsOverview(data, taskSummary) {
    const panel = document.getElementById('statsPanel');
    if (!panel) return;
    const annotated = Number(data.annotated || 0);
    const tp = Number(data.tp || 0);
    const fn = Number(data.fn || 0);
    const fp = Number(data.fp || 0);
    const tn = Number(data.tn || 0);
    const f1Score = data.f1_score !== undefined && data.f1_score !== null
        ? Number(data.f1_score)
        : calcF1Score(tp, fp, fn);
    const hasData = annotated > 0;

    panel.className = 'stats-overview';
    panel.innerHTML = `
        ${renderOverviewMetricsCard(data, f1Score, hasData)}
        ${renderConfusionMatrix(tp, fn, fp, tn)}
        ${renderTaskStatusCard(taskSummary)}
    `;
    applyMetricHelpTitles();
}

function renderStatsOverviewLoading() {
    const panel = document.getElementById('statsPanel');
    if (!panel) return;
    panel.className = 'stats-overview is-loading';
    panel.innerHTML = `
        <div class="overview-card overview-card-loading">
            <div class="overview-skeleton overview-skeleton-metrics"></div>
        </div>
        <div class="overview-card overview-card-loading">
            <div class="overview-skeleton overview-skeleton-grid"></div>
        </div>
        <div class="overview-card overview-card-loading">
            <div class="overview-skeleton overview-skeleton-pills"></div>
        </div>
    `;
}

function syntaxHighlightJson(json) {
    if (typeof json !== 'string') {
        json = JSON.stringify(json, null, 2);
    }
    json = escapeHtml(json);
    return json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, function (match) {
        let cls = 'json-number';
        if (/^"/.test(match)) {
            if (/:$/.test(match)) {
                cls = 'json-key';
            } else {
                cls = 'json-string';
            }
        } else if (/true|false/.test(match)) {
            cls = 'json-boolean';
        } else if (/null/.test(match)) {
            cls = 'json-null';
        }
        return '<span class="' + cls + '">' + match + '</span>';
    });
}

function highlightYamlText(text) {
    return escapeHtml(text || '').split('\n').map(line => {
        let html = line.replace(/^(\s*[-]?\s*)([A-Za-z0-9_\-]+)(\s*:)/, '$1<span class="yaml-key">$2</span>$3');
        html = html.replace(/(:\s*)(["'][^"']*["']|[^#\n]+)?/, (match, prefix, value = '') => {
            const trimmed = value.trim();
            let valueHtml = value;
            if (/^(true|false|null)$/i.test(trimmed)) {
                valueHtml = value.replace(trimmed, `<span class="yaml-boolean">${trimmed}</span>`);
            } else if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
                valueHtml = value.replace(trimmed, `<span class="yaml-number">${trimmed}</span>`);
            } else if (trimmed) {
                valueHtml = value.replace(trimmed, `<span class="yaml-string">${trimmed}</span>`);
            }
            return prefix + valueHtml;
        });
        return html.replace(/(#.*)$/g, '<span class="code-comment">$1</span>');
    }).join('\n');
}

function highlightTxtText(text) {
    return escapeHtml(text || '')
        .replace(/(\{\{.*?\}\})/g, '<span class="txt-var">$1</span>')
        .replace(/^(\s*#+\s.*)$/gm, '<span class="txt-heading">$1</span>')
        .replace(/(TODO|todo|Todo)/g, '<span class="txt-todo">$1</span>');
}

function updateCodePreview(type) {
    const editor = document.getElementById(`${type}Editor`);
    const preview = document.getElementById(`${type}Preview`);
    if (!editor || !preview) return;
    const text = editor.value || '';
    if (type === 'rule') {
        preview.innerHTML = syntaxHighlightJson(text);
    } else if (type === 'model') {
        preview.innerHTML = highlightYamlText(text);
    } else if (type === 'knowledge') {
        try {
            preview.innerHTML = syntaxHighlightJson(JSON.stringify(JSON.parse(text), null, 2));
        } catch (_) {
            preview.innerHTML = highlightTxtText(text);
        }
    } else {
        preview.innerHTML = highlightTxtText(text);
    }
}

// ==================== 1. 初始化模块 ====================
document.addEventListener('DOMContentLoaded', async function () {
    showGlobalLoading('正在初始化...');
    try {
        await Promise.all([
            loadSettings(),
            loadModels(),
            loadFields(),
            loadPromptList(),
            loadKnowledgeList(),
            loadRule(),
            loadStrategies()
        ]);
        applyDefaultSettings();
        await loadRows({ silent: true });
        await loadStats();
        startTaskPolling();
    } finally {
        hideGlobalLoading();
    }

    // 模型选择下拉框事件
    document.getElementById('modelSelect').addEventListener('change', async function () {
        state.currentModel = this.value;
        state.currentPage = 1;
        await reloadCurrentCombo('正在切换模型...');
    });

    document.getElementById('strategySelect').addEventListener('change', function () {
        handleStrategyChange(this.value);
    });

    initComboTimers();
    initClearDataSlider();
    initRangeSlider();
    applyMetricHelpTitles();
    syncConcurrencyInput();
    document.addEventListener('click', handleDocumentClick);
    document.addEventListener('mousemove', handleCellTooltipMouseMove);
    document.addEventListener('scroll', hideCellTooltip, true);
    document.addEventListener('pointerover', handleMetricTooltipOver);
    document.addEventListener('pointermove', moveMetricTooltip);
    document.addEventListener('pointerout', handleMetricTooltipOut);
    document.addEventListener('mouseover', handleMetricTooltipOver);
    document.addEventListener('mousemove', moveMetricTooltip);
    document.addEventListener('mouseout', handleMetricTooltipOut);
});

async function loadSettings() {
    try {
        const data = await api('/api/settings');
        state.settings = { ...state.settings, ...(data || {}) };
    } catch (e) {
        console.error('加载默认设置失败', e);
    }
}

function applyDefaultSettings() {
    const modelSelect = document.getElementById('modelSelect');
    const strategySelect = document.getElementById('strategySelect');
    if (state.settings.default_model && modelSelect && [...modelSelect.options].some(opt => opt.value === state.settings.default_model)) {
        modelSelect.value = state.settings.default_model;
        state.currentModel = state.settings.default_model;
    }
    if (state.settings.default_strategy && strategySelect && [...strategySelect.options].some(opt => opt.value === state.settings.default_strategy)) {
        strategySelect.value = state.settings.default_strategy;
        state.currentStrategy = state.settings.default_strategy;
    }
    const combo = getCurrentComboName();
    if (combo && !state.comboConcurrency[combo]) {
        state.comboConcurrency[combo] = clampConcurrency(state.settings.default_concurrency || 1);
        localStorage.setItem('comboConcurrency', JSON.stringify(state.comboConcurrency));
    }
    syncConcurrencyInput();
}

function openDefaultSettingsModal() {
    const modelSelect = document.getElementById('defaultModelSelect');
    const strategySelect = document.getElementById('defaultStrategySelect');
    const concurrencyInput = document.getElementById('defaultConcurrencyInput');
    if (!modelSelect || !strategySelect || !concurrencyInput) return;
    const models = getModelNames();
    modelSelect.innerHTML = '<option value="">不设置</option>' + models.map(model =>
        `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`
    ).join('');
    strategySelect.innerHTML = '<option value="">不设置</option>' + (state.strategies || []).map(strategy =>
        `<option value="${escapeHtml(strategy)}">${escapeHtml(strategy)}</option>`
    ).join('');
    modelSelect.value = state.settings.default_model || '';
    strategySelect.value = state.settings.default_strategy || '';
    concurrencyInput.value = clampConcurrency(state.settings.default_concurrency || 1);
    document.getElementById('defaultSettingsModal').classList.remove('hidden');
}

function closeDefaultSettingsModal() {
    const modal = document.getElementById('defaultSettingsModal');
    if (modal) modal.classList.add('hidden');
}

async function saveDefaultSettings() {
    const model = document.getElementById('defaultModelSelect').value;
    const strategy = document.getElementById('defaultStrategySelect').value;
    const concurrency = clampConcurrency(document.getElementById('defaultConcurrencyInput').value);
    const settings = {
        default_model: model,
        default_strategy: strategy,
        default_concurrency: concurrency
    };
    const data = await api('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
    });
    state.settings = data.settings || settings;
    applyDefaultSettings();
    closeDefaultSettingsModal();
    showToast('默认设置已保存');
}

async function loadStrategies() {
    try {
        const data = await api('/api/strategies');
        state.strategies = data.strategies || [];
        const select = document.getElementById('strategySelect');
        select.innerHTML = state.strategies.map(s =>
            `<option value="${s}">${s}</option>`
        ).join('');
        if (state.strategies.length > 0) {
            state.currentStrategy = state.strategies[0];
        }
    } catch (e) {
        console.error('加载策略列表失败', e);
    }
}

async function handleStrategyChange(value) {
    state.currentStrategy = value;
    state.currentPage = 1;
    await reloadCurrentCombo('正在切换方案...');
}

async function reloadCurrentCombo(message) {
    showGlobalLoading(message);
    try {
        syncConcurrencyInput();
        await Promise.all([
            loadRows({ silent: true }),
            loadStats(),
            refreshStatsPageIfVisible()
        ]);
    } finally {
        hideGlobalLoading();
    }
}

function getCurrentModelValue() {
    const select = document.getElementById('modelSelect');
    const value = select && select.value ? select.value : state.currentModel;
    state.currentModel = value || '';
    return state.currentModel;
}

function getCurrentStrategyValue() {
    const select = document.getElementById('strategySelect');
    const value = select && select.value ? select.value : state.currentStrategy;
    state.currentStrategy = value || state.currentStrategy || 'baseline_rule';
    return state.currentStrategy;
}

/**
 * 获取当前选中的 模型×策略 组合名称，格式与后端一致：模型名(策略名)
 * 例如：qwen-plus(方案A)
 */
function getCurrentComboName() {
    const model = getCurrentModelValue();
    if (!model) return '';
    const baseName = model.replace('.yaml', '');
    const strategy = getCurrentStrategyValue();
    return `${baseName}(${strategy})`;
}

async function loadModels(selectModelFileName) {
    try {
        const data = await api('/api/models');
        state.models = data.models || data || [];
        const select = document.getElementById('modelSelect');
        // 保留第一个默认 option
        select.innerHTML = '<option value="">选择模型...</option>';
        state.models.forEach(m => {
            const name = typeof m === 'string' ? m : (m.name || m.model_name || '');
            if (name) {
                const opt = document.createElement('option');
                opt.value = name;
                opt.textContent = name;
                select.appendChild(opt);
            }
        });
        const currentStillExists = state.currentModel && state.models.some(m => {
            const name = typeof m === 'string' ? m : (m.name || m.model_name || '');
            return name === state.currentModel;
        });
        if (selectModelFileName) {
            select.value = selectModelFileName;
            state.currentModel = selectModelFileName;
        } else if (currentStillExists) {
            select.value = state.currentModel;
        }
        // 默认选第一个
        else if (state.models.length > 0) {
            const firstName = typeof state.models[0] === 'string' ? state.models[0] : (state.models[0].name || state.models[0].model_name || '');
            if (firstName) {
                select.value = firstName;
                state.currentModel = firstName;
            }
        }
        renderModelList(selectModelFileName);
    } catch (e) {
        console.error('加载模型列表失败', e);
    }
}

async function loadFields() {
    try {
        const data = await api('/api/fields');
        state.fields = data.fields || data || [];
    } catch (e) {
        console.error('加载字段配置失败', e);
    }
}

async function loadRule() {
    try {
        const data = await api('/api/rule');
        state.rule = data || state.rule;
    } catch (e) {
        console.error('加载规则配置失败', e);
    }
}

// ==================== 2. Excel 上传模块 ====================
function handleUploadExcelClick() {
    if (state.total > 0) {
        showToast('已有数据，请先删除数据后再上传新 Excel', 'warning');
        return;
    }
    const input = document.getElementById('fileInput');
    if (input) input.click();
}

async function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (state.total > 0) {
        showToast('已有数据时请先删除全部数据', 'warning');
        event.target.value = '';
        return;
    }

    const formData = new FormData();
    formData.append('file', file);

    try {
        showToast('正在上传文件...', 'warning');
        const data = await api('/api/upload', {
            method: 'POST',
            body: formData
        });

        state.uploadedFilename = data.filename || file.name;
        state.uploadedColumns = data.columns || [];
        state.dataColumnVisibilityOverrides = {};
        localStorage.removeItem('dataColumnVisibilityOverridesV1');

        showToast(`导入成功：${data.imported || 0} 条`, 'success');
        await loadRows();
        await loadStats();
    } catch (e) {
        console.error('上传失败', e);
    }

    // 重置 file input 以支持重复上传同名文件
    event.target.value = '';
}

// ==================== 3. 表格渲染模块 ====================
async function loadRows(options = {}) {
    const silent = !!options.silent;
    if (!silent) {
        state.loadingRows = true;
        renderTable();
    }
    try {
        const params = new URLSearchParams({
            page: state.currentPage,
            page_size: state.pageSize
        });
        if (state.search) params.set('search', state.search);
        if (state.filter) params.set('filter', state.filter);
        if (state.sortBy) {
            params.set('sort_by', state.sortBy);
            params.set('sort_dir', state.sortDir);
        }
        // 传递完整的 model(strategy) 组合名，与后端存储格式一致
        const comboName = getCurrentComboName();
        if (comboName) params.set('model', comboName);

        const data = await api(`/api/rows?${params.toString()}`);

        state.rows = data.rows || data.items || [];
        state.total = data.total || 0;
        state.totalPages = data.pages || data.total_pages || Math.ceil(state.total / state.pageSize) || 1;
        document.getElementById('totalCount').textContent = state.total;
        updateDataActionStates();
        const jumpInput = document.getElementById('pageJumpInput');
        if (jumpInput) {
            jumpInput.max = state.totalPages;
            jumpInput.value = state.currentPage;
        }
        renderTable();
        renderPagination();
    } catch (e) {
        console.error('加载数据失败', e);
    } finally {
        if (!silent) {
            state.loadingRows = false;
            renderTable();
        }
    }
}

function updateDataActionStates() {
    const hasData = state.total > 0;
    const uploadBtn = document.getElementById('uploadExcelBtn');
    const clearBtn = document.getElementById('clearAllDataBtn');
    const fileInput = document.getElementById('fileInput');
    if (uploadBtn) {
        uploadBtn.disabled = false;
        uploadBtn.classList.toggle('is-disabled', hasData);
        uploadBtn.dataset.disabled = hasData ? 'true' : 'false';
        uploadBtn.title = hasData ? '请先删除数据后再上传新 Excel' : '';
    }
    if (fileInput) fileInput.disabled = hasData;
    if (clearBtn) {
        clearBtn.disabled = !hasData;
        clearBtn.title = hasData ? '' : '暂无数据可删除';
    }
}

function renderTable() {
    const thead = document.getElementById('tableHead');
    const tbody = document.getElementById('tableBody');

    if (state.loadingRows) {
        thead.innerHTML = '<tr><th class="px-4 py-3 text-center" colspan="99">正在加载数据</th></tr>';
        tbody.innerHTML = '<tr><td class="table-loading-row" colspan="99"><span class="annotation-loading"><span class="loading-spinner"></span><span>正在加载当前组合数据...</span></span></td></tr>';
        updateSelectionSummary();
        updateRangeSelector();
        return;
    }

    if (state.rows.length === 0) {
        thead.innerHTML = '<tr><th class="px-4 py-3 text-center" colspan="99">暂无数据</th></tr>';
        tbody.innerHTML = '';
        renderColumnChooser(buildTableColumns());
        updateSelectionSummary();
        updateRangeSelector();
        return;
    }

    const columns = buildTableColumns();
    state.autoColumnWidths = calculateAutoColumnWidths(columns);
    const visibleColumns = getVisibleColumns(columns);
    renderColumnChooser(columns);

    // 构建表头
    const allVisibleSelected = state.rows.length > 0 && state.rows.every(row => state.selectedRowIds.has(String(row.id || row._id)));
    let headerHtml = '<tr>';
    headerHtml += `<th class="px-4 py-3 font-semibold select-col" data-col-id="meta:select" style="${getColumnStyle('meta:select', 48)}">
        <input type="checkbox" class="row-checkbox" onchange="toggleSelectAllRows(this.checked)" ${allVisibleSelected ? 'checked' : ''} title="全选当前页">
        <span class="col-resizer" onmousedown="startColumnResize(event, 'meta:select')" title="拖动调整列宽"></span>
    </th>`;
    headerHtml += renderTableHeaderCell('meta:row_index', '#', 'row_index', 72);
    visibleColumns.forEach(col => {
        const sortKey = col.sortKey || col.id;
        headerHtml += renderTableHeaderCell(col.id, col.label, sortKey, getDefaultColumnWidth(col));
    });
    headerHtml += renderTableHeaderCell('meta:actions', '操作', '', 340, 'text-center', false);
    headerHtml += '</tr>';
    thead.innerHTML = headerHtml;

    // 构建表体
    let bodyHtml = '';
    state.rows.forEach((row, idx) => {
        const rowIndex = (state.currentPage - 1) * state.pageSize + idx + 1;
        const rowId = row.id || row._id || idx;
        const matchType = row.match_type || '';
        const results = row.results || {};
        const selected = state.selectedRowIds.has(String(rowId));
        const activeTask = getCurrentRowJob(rowId);

        bodyHtml += `<tr class="transition-colors ${selected ? 'row-selected' : ''}">`;
        bodyHtml += `<td class="px-4 py-3 select-col" data-col-id="meta:select" style="${getColumnStyle('meta:select', 48)}">
            ${activeTask
                ? `<button class="row-cancel-btn" onclick="cancelRowAnnotation('${rowId}')" title="终止标注">×</button>`
                : `<input type="checkbox" class="row-checkbox" onchange="toggleRowSelection('${rowId}', this.checked)" ${selected ? 'checked' : ''}>`}
        </td>`;
        bodyHtml += `<td class="px-4 py-3 text-gray-500" data-col-id="meta:row_index" style="${getColumnStyle('meta:row_index', 72)}">${rowIndex}</td>`;

        visibleColumns.forEach(col => {
            let cellHtml = '';
            if (col.type === 'meta' && col.key === 'match_type') {
                cellHtml = renderMatchBadge(matchType);
            } else if (col.type === 'meta' && col.key === 'task_status') {
                cellHtml = renderTaskStatus(rowId);
            } else {
                cellHtml = buildCellHtml(getColumnValue(row, col));
            }
            bodyHtml += `<td class="px-4 py-3" data-col-id="${escapeHtml(col.id)}" style="${getColumnStyle(col.id, getDefaultColumnWidth(col))}">${cellHtml}</td>`;
        });

        const currentComboName = getCurrentComboName();
        const hasAnnotation = currentComboName && results.hasOwnProperty(currentComboName);
        const isAnnotating = !!activeTask;
        bodyHtml += `<td class="px-4 py-3 text-center" data-col-id="meta:actions" style="${getColumnStyle('meta:actions', 340)}">
            <div class="flex items-center justify-center gap-2">`;
        if (isAnnotating) {
            bodyHtml += `<span class="annotation-inline-status"><span class="loading-spinner"></span> 标注中</span>`;
        } else if (!hasAnnotation) {
            bodyHtml += `<button class="action-btn action-btn-primary" onclick="annotateRow('${rowId}')">标注</button>`;
        } else {
            bodyHtml += `<button class="action-btn action-btn-warning" onclick="annotateRow('${rowId}')">重新标注</button>`;
            bodyHtml += `<button class="action-btn action-btn-export" onclick="exportRowJson('${rowId}')">导出JSON</button>`;
        }
        bodyHtml += `<button class="action-btn action-btn-info" onclick="showDetail('${rowId}')">详情</button>`;
        bodyHtml += `<button class="action-btn action-btn-danger" onclick="deleteRowsByIds(['${rowId}'])">删除</button>`;
        bodyHtml += `</div></td>`;

        bodyHtml += '</tr>';
    });
    tbody.innerHTML = bodyHtml;
    updateSelectionSummary();
    updateRangeSelector();
}

function toggleRowSelection(rowId, checked) {
    const id = String(rowId);
    if (checked) {
        state.selectedRowIds.add(id);
    } else {
        state.selectedRowIds.delete(id);
    }
    renderTable();
}

function toggleSelectAllRows(checked) {
    state.rows.forEach(row => {
        const id = String(row.id || row._id);
        if (checked) {
            state.selectedRowIds.add(id);
        } else {
            state.selectedRowIds.delete(id);
        }
    });
    renderTable();
}

function clearRowSelection() {
    state.selectedRowIds.clear();
    resetRangeSelection();
    renderTable();
}

function resetRangeSelection() {
    const range = state.rangeSelection;
    range.start = 1;
    range.end = 1;
    range.touched = false;
    range.dragging = '';
}

function isRangeEmptyAtOrigin() {
    const range = state.rangeSelection;
    return range.start <= 1 && range.end <= 1;
}

function getRangeSelectionCount() {
    if (state.total <= 0) return 0;
    if (isRangeEmptyAtOrigin()) return 0;
    const range = state.rangeSelection;
    return Math.max(0, range.end - range.start + 1);
}

function hasActiveRangeSelection() {
    return state.total > 0 && !!state.rangeSelection.touched && getRangeSelectionCount() > 0;
}

function updateSelectionSummary() {
    const el = document.getElementById('selectedCount');
    const hasSelected = state.selectedRowIds.size > 0;
    const hasRange = hasActiveRangeSelection();
    const bulkCount = hasSelected ? state.selectedRowIds.size : (hasRange ? getRangeSelectionCount() : 0);
    if (el) el.textContent = bulkCount;
    const annotateText = document.getElementById('annotateSelectedText');
    if (annotateText) annotateText.textContent = '批量操作';
    ['annotateSelectedBtn', 'clearAnnotationBtn', 'deleteSelectedRowsBtn'].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) btn.disabled = !(hasSelected || hasRange);
    });
    const clearSelectionBtn = document.getElementById('clearSelectionBtn');
    if (clearSelectionBtn) clearSelectionBtn.disabled = !(hasSelected || hasRange);
    const bulkActionBtn = document.getElementById('bulkActionBtn');
    if (bulkActionBtn) bulkActionBtn.disabled = !(hasSelected || hasRange);
    if (!hasSelected && !hasRange) hideBulkActionMenu();
}

function getCurrentListParams() {
    const params = new URLSearchParams();
    if (state.search) params.set('search', state.search);
    if (state.filter) params.set('filter', state.filter);
    if (state.sortBy) {
        params.set('sort_by', state.sortBy);
        params.set('sort_dir', state.sortDir);
    }
    const comboName = getCurrentComboName();
    if (comboName) params.set('model', comboName);
    return params;
}

function initRangeSlider() {
    const startThumb = document.getElementById('rangeStartThumb');
    const endThumb = document.getElementById('rangeEndThumb');
    if (!startThumb || !endThumb) return;

    const beginDrag = (which, event) => {
        state.rangeSelection.dragging = which;
        state.rangeSelection.touched = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        updateRangeFromPointer(event.clientX);
    };
    startThumb.addEventListener('pointerdown', event => beginDrag('start', event));
    endThumb.addEventListener('pointerdown', event => beginDrag('end', event));
    document.addEventListener('pointermove', event => updateRangeFromPointer(event.clientX));
    document.addEventListener('pointerup', () => {
        state.rangeSelection.dragging = '';
        updateSelectionSummary();
    });
}

function updateRangeFromPointer(clientX) {
    const dragging = state.rangeSelection.dragging;
    if (!dragging || state.total <= 0) return;
    const track = document.getElementById('rangeTrack');
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    const nextValue = Math.max(1, Math.min(state.total, Math.round(ratio * (state.total - 1)) + 1));
    if (dragging === 'start') {
        state.rangeSelection.start = Math.min(nextValue, state.rangeSelection.end);
    } else {
        state.rangeSelection.end = Math.max(nextValue, state.rangeSelection.start);
    }
    if (isRangeEmptyAtOrigin()) {
        state.selectedRowIds.clear();
        state.rangeSelection.touched = false;
    } else {
        state.rangeSelection.touched = true;
    }
    updateRangeSelector();
}

function updateRangeSelector() {
    const panel = document.getElementById('rangeSelector');
    if (!panel) return;
    const hasData = state.total > 0;
    panel.classList.toggle('hidden', !hasData);
    if (!hasData) return;

    const range = state.rangeSelection;
    if (range.total !== state.total) {
        range.total = state.total;
        range.start = 1;
        range.end = 1;
        range.touched = false;
    }
    if (!range.start || range.start < 1) range.start = 1;
    if (!range.end || range.end < 1) range.end = 1;
    range.start = Math.max(1, Math.min(state.total, range.start));
    range.end = Math.max(range.start, Math.min(state.total, range.end));

    const startPercent = state.total <= 1 ? 0 : ((range.start - 1) / (state.total - 1)) * 100;
    const endPercent = state.total <= 1 ? 100 : ((range.end - 1) / (state.total - 1)) * 100;
    const startThumb = document.getElementById('rangeStartThumb');
    const endThumb = document.getElementById('rangeEndThumb');
    const fill = document.getElementById('rangeFill');
    const label = document.getElementById('rangeSelectorLabel');
    const count = document.getElementById('rangeSelectorCount');
    const startCount = document.getElementById('rangeStartCount');
    const endCount = document.getElementById('rangeEndCount');
    const selectedCount = document.getElementById('rangeSelectedCount');
    const stepLeft = document.getElementById('rangeStepLeftBtn');
    const stepRight = document.getElementById('rangeStepRightBtn');
    if (startThumb) startThumb.style.left = `${startPercent}%`;
    if (endThumb) endThumb.style.left = `${endPercent}%`;
    if (fill) {
        fill.style.left = `${startPercent}%`;
        fill.style.width = `${Math.max(0, endPercent - startPercent)}%`;
    }
    const rangeCount = getRangeSelectionCount();
    if (label) label.textContent = `范围 ${range.start} - ${range.end}`;
    if (count) count.textContent = `选中 ${rangeCount} / ${state.total} 条`;
    if (startCount) startCount.textContent = `左 ${range.start}`;
    if (endCount) endCount.textContent = `右 ${range.end}`;
    if (selectedCount) selectedCount.textContent = `共 ${rangeCount} 条`;
    if (stepLeft) stepLeft.disabled = range.start <= 1;
    if (stepRight) stepRight.disabled = range.end >= state.total;
    updateSelectionSummary();
}

function adjustRangeBoundary(boundary, delta) {
    if (state.total <= 0) return;
    const range = state.rangeSelection;
    updateRangeSelector();
    range.touched = true;
    if (boundary === 'start') {
        range.start = Math.max(1, Math.min(range.end, range.start + delta));
    } else if (boundary === 'end') {
        range.end = Math.max(range.start, Math.min(state.total, range.end + delta));
    }
    updateRangeSelector();
}

async function selectRangeRows(options = {}) {
    if (state.total <= 0) {
        showToast('暂无数据可选择', 'warning');
        return [];
    }
    const ids = await fetchRangeRowIds();
    if (options.replace) state.selectedRowIds.clear();
    ids.forEach(id => state.selectedRowIds.add(String(id)));
    renderTable();
    if (!options.silent) showToast(`已选中范围内 ${ids.length} 条数据`);
    return ids;
}

async function fetchRangeRowIds() {
    if (getRangeSelectionCount() <= 0) return [];
    const params = getCurrentListParams();
    params.set('start', state.rangeSelection.start);
    params.set('end', state.rangeSelection.end);
    const data = await api(`/api/rows/range-ids?${params.toString()}`);
    return (data.ids || []).map(id => String(id));
}

async function toggleBulkActionMenu(event) {
    if (event) event.stopPropagation();
    if (state.total <= 0 || (state.selectedRowIds.size === 0 && !hasActiveRangeSelection())) return;
    const panel = document.getElementById('bulkActionPanel');
    if (panel) panel.classList.toggle('hidden');
}

function hideBulkActionMenu() {
    const panel = document.getElementById('bulkActionPanel');
    if (panel) panel.classList.add('hidden');
}

function renderSortIcon(key) {
    const dir = state.sortBy === key ? state.sortDir : 'none';
    return `<span class="sort-icon sort-${dir}" aria-hidden="true"></span>`;
}

function sortTable(key) {
    if (state.sortBy === key) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
        state.sortBy = key;
        state.sortDir = 'asc';
    }
    state.currentPage = 1;
    loadRows();
}

function buildTableColumns() {
    const columns = [
        { id: 'meta:id', type: 'meta', key: 'id', label: 'ID', sortKey: 'id' },
        { id: 'meta:human_answer', type: 'meta', key: 'human_answer', label: '人工答案', sortKey: 'human_answer' },
        { id: 'meta:task_status', type: 'meta', key: 'task_status', label: '任务状态', sortKey: '' },
        { id: 'meta:match_type', type: 'meta', key: 'match_type', label: '匹配类型', sortKey: 'match_type' },
        { id: 'meta:duration', type: 'meta', key: 'duration', label: '标注耗时', sortKey: '' },
    ];

    const dataKeys = [];
    state.rows.forEach(row => {
        if (row.data && typeof row.data === 'object') {
            Object.keys(row.data).forEach(k => {
                if (!dataKeys.includes(k)) dataKeys.push(k);
            });
        }
    });
    if (dataKeys.length === 0) {
        const configuredFields = [
            ...(state.rule.excel_fields || []),
            ...(state.rule.annotate_fields || []),
        ];
        configuredFields.forEach(field => {
            if (field && !dataKeys.includes(field)) dataKeys.push(field);
        });
    }
    const configuredExcelFields = (state.rule.excel_fields || []).filter(Boolean);
    const orderedDataKeys = [
        ...configuredExcelFields.filter(field => dataKeys.includes(field)),
        ...dataKeys.filter(field => !configuredExcelFields.includes(field)),
    ];
    orderedDataKeys.forEach(field => {
        columns.push({ id: `data:${field}`, type: 'data', field, label: field, sortKey: `data:${field}` });
    });

    const modelFieldMap = {};
    state.rows.forEach(row => {
        if (row.results && typeof row.results === 'object') {
            const currentComboName = getCurrentComboName();
            const visibleModelNames = currentComboName && row.results[currentComboName]
                ? [currentComboName]
                : [];
            visibleModelNames.forEach(modelName => {
                if (!modelFieldMap[modelName]) modelFieldMap[modelName] = [];
                const result = row.results[modelName];
                if (result && typeof result === 'object') {
                    Object.keys(result).forEach(key => {
                        if (key === '标注耗时' || key === '标注耗时(ms)') return;
                        if (!modelFieldMap[modelName].includes(key)) {
                            modelFieldMap[modelName].push(key);
                        }
                    });
                }
            });
        }
    });

    const modelNames = Object.keys(modelFieldMap);
    modelNames.forEach(modelName => {
        modelFieldMap[modelName].forEach(fieldKey => {
            columns.push({
                id: `result:${modelName}:${fieldKey}`,
                type: 'result',
                modelName,
                fieldKey,
                label: fieldKey
            });
        });
    });

    return columns;
}

function normalizeDataColumnVisibilityOverrides(columns) {
    const validIds = new Set(columns.filter(col => col.type === 'data').map(col => col.id));
    const next = {};
    Object.entries(state.dataColumnVisibilityOverrides || {}).forEach(([columnId, visible]) => {
        if (validIds.has(columnId) && typeof visible === 'boolean') {
            next[columnId] = visible;
        }
    });
    state.dataColumnVisibilityOverrides = next;
    localStorage.setItem('dataColumnVisibilityOverridesV1', JSON.stringify(next));
}

function applyConfiguredColumnVisibility(columns) {
    normalizeDataColumnVisibilityOverrides(columns);
    const configuredExcelFields = new Set((state.rule.excel_fields || []).filter(Boolean));
    const nextHidden = new Set(
        (Array.isArray(state.hiddenColumns) ? state.hiddenColumns : [])
            .filter(id => !String(id).startsWith('data:'))
    );

    columns.forEach(col => {
        if (col.type !== 'data') return;
        const override = state.dataColumnVisibilityOverrides[col.id];
        const defaultVisible = configuredExcelFields.size === 0 || configuredExcelFields.has(col.field);
        const shouldShow = typeof override === 'boolean' ? override : defaultVisible;
        if (shouldShow) {
            nextHidden.delete(col.id);
        } else {
            nextHidden.add(col.id);
        }
    });

    state.hiddenColumns = Array.from(nextHidden);
    localStorage.setItem('hiddenColumns', JSON.stringify(state.hiddenColumns));
}

function getVisibleColumns(columns) {
    applyConfiguredColumnVisibility(columns);
    const ids = columns.map(col => col.id);
    state.hiddenColumns = (state.hiddenColumns || []).filter(id => ids.includes(id));
    localStorage.setItem('hiddenColumns', JSON.stringify(state.hiddenColumns));
    return columns.filter(col => !state.hiddenColumns.includes(col.id));
}

function renderColumnChooser(columns) {
    const container = document.getElementById('columnChooser');
    const countEl = document.getElementById('columnCount');
    if (!container || !countEl) return;

    const selected = columns
        .filter(col => !state.hiddenColumns.includes(col.id))
        .map(col => col.id);
    countEl.textContent = selected.length;
    container.innerHTML = columns.map(col => {
        const active = selected.includes(col.id);
        return `<button type="button" class="column-choice ${active ? 'active' : ''}" onclick="event.stopPropagation();toggleColumn('${escapeJs(col.id)}', ${!active})">
            ${escapeHtml(col.label)}
        </button>`;
    }).join('');
}

function escapeJs(str) {
    return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function toggleColumnPanel(event) {
    if (event) event.stopPropagation();
    document.getElementById('columnPanel').classList.toggle('hidden');
    hideToolbarMoreMenu();
}

function hideColumnPanel() {
    const panel = document.getElementById('columnPanel');
    if (panel) panel.classList.add('hidden');
}

function toggleToolbarMoreMenu(event) {
    if (event) event.stopPropagation();
    hideColumnPanel();
    const panel = document.getElementById('toolbarMorePanel');
    if (panel) panel.classList.toggle('hidden');
}

function hideToolbarMoreMenu() {
    const panel = document.getElementById('toolbarMorePanel');
    if (panel) panel.classList.add('hidden');
}

function handleDocumentClick(event) {
    const panel = document.getElementById('columnPanel');
    const toggle = document.getElementById('columnToggleBtn');
    if (panel && toggle && !panel.contains(event.target) && !toggle.contains(event.target)) {
        panel.classList.add('hidden');
    }
    const morePanel = document.getElementById('toolbarMorePanel');
    const moreToggle = document.getElementById('toolbarMoreBtn');
    if (morePanel && moreToggle && !morePanel.contains(event.target) && !moreToggle.contains(event.target)) {
        morePanel.classList.add('hidden');
    }
    const bulkPanel = document.getElementById('bulkActionPanel');
    const bulkToggle = document.getElementById('bulkActionBtn');
    if (bulkPanel && bulkToggle && !bulkPanel.contains(event.target) && !bulkToggle.contains(event.target)) {
        bulkPanel.classList.add('hidden');
    }

    document.querySelectorAll('.modal-overlay').forEach(modal => {
        if (!modal.classList.contains('hidden') && event.target === modal) {
            modal.classList.add('hidden');
        }
    });
}

function toggleColumn(columnId, checked) {
    const hidden = Array.isArray(state.hiddenColumns) ? [...state.hiddenColumns] : [];
    const idx = hidden.indexOf(columnId);
    if (String(columnId).startsWith('data:')) {
        state.dataColumnVisibilityOverrides[columnId] = !!checked;
        localStorage.setItem('dataColumnVisibilityOverridesV1', JSON.stringify(state.dataColumnVisibilityOverrides));
    }
    if (checked && idx >= 0) {
        hidden.splice(idx, 1);
    }
    if (!checked && idx < 0) {
        hidden.push(columnId);
    }
    state.hiddenColumns = hidden;
    localStorage.setItem('hiddenColumns', JSON.stringify(state.hiddenColumns));
    renderTable();
}

function setAllColumns(checked) {
    const columns = buildTableColumns();
    const nextOverrides = { ...(state.dataColumnVisibilityOverrides || {}) };
    columns.forEach(col => {
        if (col.type === 'data') {
            nextOverrides[col.id] = !!checked;
        }
    });
    state.dataColumnVisibilityOverrides = nextOverrides;
    localStorage.setItem('dataColumnVisibilityOverridesV1', JSON.stringify(state.dataColumnVisibilityOverrides));
    state.hiddenColumns = checked ? [] : columns.map(col => col.id);
    localStorage.setItem('hiddenColumns', JSON.stringify(state.hiddenColumns));
    renderTable();
}

function getColumnValue(row, col) {
    if (!row || !col) return '';
    const rowId = row.id || row._id || '';
    const rowData = row.data || {};
    const results = row.results || {};

    if (col.type === 'meta' && col.key === 'id') return rowId;
    if (col.type === 'meta' && col.key === 'human_answer') return row.human_answer || row.answer || '';
    if (col.type === 'meta' && col.key === 'task_status') return getTaskStatusText(rowId);
    if (col.type === 'meta' && col.key === 'match_type') return row.match_type || '未标注';
    if (col.type === 'meta' && col.key === 'duration') {
        const modelResult = results[getCurrentComboName()] || {};
        return modelResult['标注耗时'] || '';
    }
    if (col.type === 'data') return rowData[col.field] !== undefined ? rowData[col.field] : '';
    if (col.type === 'result') {
        const modelResult = results[col.modelName] || {};
        return modelResult[col.fieldKey] !== undefined ? modelResult[col.fieldKey] : '';
    }
    return '';
}

function estimateTextWidth(value) {
    const text = value === null || value === undefined ? '' : String(value);
    const inlineText = text.replace(/\s+/g, ' ').trim();
    let width = 0;
    for (const ch of inlineText) {
        if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) {
            width += 14;
        } else if (/[A-Z0-9{}\[\](),.:;"'_]/.test(ch)) {
            width += 8;
        } else if (/\s/.test(ch)) {
            width += 4;
        } else {
            width += 7;
        }
    }
    return width;
}

function getColumnWidthBounds(col) {
    if (!col) return { min: 92, max: 360 };
    if (col.id === 'meta:id') return { min: 72, max: 110 };
    if (col.id === 'meta:human_answer') return { min: 112, max: 160 };
    if (col.id === 'meta:task_status') return { min: 118, max: 150 };
    if (col.id === 'meta:match_type') return { min: 108, max: 132 };
    if (col.id === 'meta:duration') return { min: 108, max: 136 };
    if (col.type === 'result') return { min: 132, max: 230 };
    if (col.type === 'data') return { min: 120, max: 260 };
    if (col.id === 'meta:actions') return { min: 320, max: 380 };
    return { min: 92, max: 360 };
}

function calculateAutoColumnWidths(columns) {
    const widths = {
        'meta:select': 48,
        'meta:row_index': 72,
        'meta:actions': 340
    };

    columns.forEach(col => {
        const bounds = getColumnWidthBounds(col);
        const samples = [col.label || ''];
        state.rows.slice(0, state.pageSize).forEach(row => {
            samples.push(getColumnValue(row, col));
        });
        const contentWidth = Math.max(...samples.map(estimateTextWidth));
        widths[col.id] = Math.max(bounds.min, Math.min(bounds.max, Math.ceil(contentWidth + 44)));
    });

    return widths;
}

function getDefaultColumnWidth(col) {
    if (!col) return 150;
    if (state.autoColumnWidths && state.autoColumnWidths[col.id]) return state.autoColumnWidths[col.id];
    if (col.id === 'meta:id') return 92;
    if (col.id === 'meta:human_answer') return 120;
    if (col.id === 'meta:task_status') return 126;
    if (col.id === 'meta:match_type') return 108;
    if (col.id === 'meta:duration') return 116;
    if (col.id === 'meta:actions') return 340;
    if (col.type === 'result') return 130;
    return 160;
}

function getColumnWidth(columnId, fallback = 150) {
    const stored = parseInt(state.columnWidths[columnId], 10);
    const base = Number.isFinite(stored) ? stored : fallback;
    return Math.max(48, Math.min(560, base));
}

function getColumnStyle(columnId, fallback = 150) {
    const width = getColumnWidth(columnId, fallback);
    return `width:${width}px;min-width:${width}px;max-width:${width}px;`;
}

function saveColumnWidth(columnId, width) {
    state.columnWidths[columnId] = Math.max(48, Math.min(560, Math.round(width)));
    localStorage.setItem('columnWidthsV2', JSON.stringify(state.columnWidths));
}

function renderTableHeaderCell(columnId, label, sortKey, fallbackWidth = 150, extraClass = '', sortable = true) {
    const sortAttr = sortable && sortKey ? `onclick="sortTable('${escapeJs(sortKey)}')"` : '';
    const sortIcon = sortable && sortKey ? renderSortIcon(sortKey) : '';
    const className = sortable && sortKey ? 'sortable-th' : '';
    return `<th class="px-4 py-3 font-semibold ${className} ${extraClass}" data-col-id="${escapeHtml(columnId)}" style="${getColumnStyle(columnId, fallbackWidth)}" ${sortAttr}>
        <span class="th-content">
            <span class="th-label">${escapeHtml(label)}</span>
            ${sortIcon}
        </span>
        <span class="col-resizer" onmousedown="startColumnResize(event, '${escapeJs(columnId)}')" title="拖动调整列宽"></span>
    </th>`;
}

let activeColumnResize = null;

function startColumnResize(event, columnId) {
    event.preventDefault();
    event.stopPropagation();
    const th = event.target.closest('th');
    activeColumnResize = {
        columnId,
        startX: event.clientX,
        startWidth: th ? th.offsetWidth : getColumnWidth(columnId)
    };
    document.body.classList.add('resizing-columns');
    document.addEventListener('mousemove', handleColumnResize);
    document.addEventListener('mouseup', stopColumnResize);
}

function handleColumnResize(event) {
    if (!activeColumnResize) return;
    const nextWidth = activeColumnResize.startWidth + event.clientX - activeColumnResize.startX;
    saveColumnWidth(activeColumnResize.columnId, nextWidth);
    applyColumnWidth(activeColumnResize.columnId);
}

function stopColumnResize() {
    activeColumnResize = null;
    document.body.classList.remove('resizing-columns');
    document.removeEventListener('mousemove', handleColumnResize);
    document.removeEventListener('mouseup', stopColumnResize);
}

function applyColumnWidth(columnId) {
    const width = getColumnWidth(columnId);
    document.querySelectorAll('[data-col-id]').forEach(el => {
        if (el.getAttribute('data-col-id') !== columnId) return;
        el.style.width = `${width}px`;
        el.style.minWidth = `${width}px`;
        el.style.maxWidth = `${width}px`;
    });
}

function buildCellHtml(value) {
    const strVal = value === null || value === undefined ? '' : String(value);
    const escaped = escapeHtml(strVal);
    const encoded = encodeURIComponent(strVal);
    return `<div class="cell-content">
        <span class="cell-truncate" data-full-text="${encoded}" ondblclick="openCellContentModal(event)" onpointerenter="showCellTooltip(event)" onmouseover="showCellTooltip(event)" onmousemove="moveCellTooltip(event)" onmouseleave="hideCellTooltip()" onpointerleave="hideCellTooltip()">${escaped}</span>
        <button class="copy-btn" onclick="event.stopPropagation();copyToClipboard(decodeURIComponent('${encoded}'))">📋</button>
    </div>`;
}

function readCellFullText(target) {
    const encoded = target && target.dataset ? (target.dataset.fullText || '') : '';
    if (!encoded) return '';
    try {
        return decodeURIComponent(encoded);
    } catch (e) {
        return encoded;
    }
}

function getCellTooltip() {
    let tooltip = document.getElementById('cellHoverTooltip');
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = 'cellHoverTooltip';
        tooltip.className = 'cell-hover-tooltip';
        document.body.appendChild(tooltip);
    }
    return tooltip;
}

function showCellTooltip(event) {
    const target = event.currentTarget;
    showCellTooltipForTarget(target, event);
}

function showCellTooltipForTarget(target, event) {
    const text = readCellFullText(target);
    if (!text) return;
    const needsTooltip = target.scrollWidth > target.clientWidth || text.length > 40;
    if (!needsTooltip) return;
    const tooltip = getCellTooltip();
    tooltip.textContent = text;
    tooltip.classList.add('visible');
    moveCellTooltip(event);
}

function handleCellTooltipMouseMove(event) {
    const tooltipEl = document.getElementById('cellHoverTooltip');
    if (tooltipEl && tooltipEl.contains(event.target)) return;
    const target = event.target && event.target.closest ? event.target.closest('.cell-truncate') : null;
    if (!target) {
        hideCellTooltip();
        return;
    }
    const tooltip = tooltipEl;
    if (tooltip && tooltip.classList.contains('visible')) {
        moveCellTooltip(event);
    } else {
        showCellTooltipForTarget(target, event);
    }
}

function moveCellTooltip(event) {
    const tooltip = document.getElementById('cellHoverTooltip');
    if (!tooltip || !tooltip.classList.contains('visible')) return;
    const margin = 14;
    const maxLeft = window.innerWidth - tooltip.offsetWidth - margin;
    const maxTop = window.innerHeight - tooltip.offsetHeight - margin;
    const left = Math.max(margin, Math.min(maxLeft, event.clientX + 14));
    const top = Math.max(margin, Math.min(maxTop, event.clientY + 14));
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
}

function hideCellTooltip() {
    const tooltip = document.getElementById('cellHoverTooltip');
    if (tooltip) tooltip.classList.remove('visible');
}

function tryParseJsonText(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch (e) {
        return null;
    }
}

function formatCellContent(text) {
    const parsed = tryParseJsonText(text);
    if (parsed !== null && typeof parsed === 'object') {
        return {
            type: 'JSON',
            html: syntaxHighlightJson(JSON.stringify(parsed, null, 2))
        };
    }
    return {
        type: 'TEXT',
        html: escapeHtml(text)
    };
}

function openCellContentModal(event) {
    event.preventDefault();
    event.stopPropagation();
    hideCellTooltip();
    const text = readCellFullText(event.currentTarget);
    const modal = document.getElementById('cellContentModal');
    const content = document.getElementById('cellContentBody');
    const badge = document.getElementById('cellContentType');
    if (!modal || !content || !badge) return;
    const formatted = formatCellContent(text);
    badge.textContent = formatted.type;
    content.innerHTML = formatted.html;
    content.dataset.rawText = text;
    modal.classList.remove('hidden');
}

function closeCellContentModal() {
    const modal = document.getElementById('cellContentModal');
    if (modal) modal.classList.add('hidden');
}

function copyCellContentModal() {
    const content = document.getElementById('cellContentBody');
    if (!content) return;
    copyToClipboard(content.dataset.rawText || content.textContent || '');
}

function getMetricTooltip() {
    let tooltip = document.getElementById('metricFloatingTooltip');
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = 'metricFloatingTooltip';
        tooltip.className = 'metric-floating-tooltip';
        document.body.appendChild(tooltip);
    }
    return tooltip;
}

function handleMetricTooltipOver(event) {
    const target = event.target && event.target.closest ? event.target.closest('.metric-help') : null;
    if (!target) return;
    const text = target.dataset.tooltip || '';
    if (!text) return;
    const tooltip = getMetricTooltip();
    tooltip.textContent = text;
    tooltip.classList.add('visible');
    moveMetricTooltip(event);
}

function moveMetricTooltip(event) {
    const tooltip = document.getElementById('metricFloatingTooltip');
    if (!tooltip || !tooltip.classList.contains('visible')) return;
    const margin = 14;
    const maxLeft = window.innerWidth - tooltip.offsetWidth - margin;
    const maxTop = window.innerHeight - tooltip.offsetHeight - margin;
    const left = Math.max(margin, Math.min(maxLeft, event.clientX + 12));
    const top = Math.max(margin, Math.min(maxTop, event.clientY + 14));
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
}

function handleMetricTooltipOut(event) {
    const fromMetric = event.target && event.target.closest ? event.target.closest('.metric-help') : null;
    if (!fromMetric) return;
    const toMetric = event.relatedTarget && event.relatedTarget.closest ? event.relatedTarget.closest('.metric-help') : null;
    if (toMetric === fromMetric) return;
    const tooltip = document.getElementById('metricFloatingTooltip');
    if (tooltip) tooltip.classList.remove('visible');
}

function applyMetricHelpTitles() {
    document.querySelectorAll('.metric-help[data-tooltip]').forEach(el => {
        el.removeAttribute('title');
    });
}

function renderMatchBadge(matchType) {
    if (!matchType) return '<span class="text-gray-400 text-xs">未标注</span>';
    const upper = matchType.toUpperCase();
    const clsMap = { 'TP': 'match-tp', 'FN': 'match-fn', 'FP': 'match-fp', 'TN': 'match-tn' };
    const cls = clsMap[upper] || '';
    return `<span class="match-badge ${cls}">${escapeHtml(upper)}</span>`;
}

function getTaskStatusText(rowId) {
    const task = getCurrentRowJob(rowId);
    if (!task) return '';
    if (task.status === 'creating') return '任务创建中';
    if (task.status === 'pending') return '排队中';
    if (task.status === 'running') return '标注中';
    if (task.status === 'failed') return '失败';
    if (task.status === 'cancelled') return '已终止';
    return '标注中';
}

function renderTaskStatus(rowId) {
    const task = getCurrentRowJob(rowId);
    if (!task) return '<span class="task-status-empty">-</span>';
    const progress = getTaskStatusText(rowId);
    const isActive = ['creating', 'pending', 'running'].includes(task.status);
    if (isActive) {
        return `<span class="annotation-loading task-status-badge task-status-${escapeHtml(task.status)}">
            <span class="loading-spinner"></span>
            <span>${escapeHtml(progress)}</span>
        </span>`;
    }
    return `<span class="task-status-badge task-status-${escapeHtml(task.status || 'unknown')}">${escapeHtml(progress)}</span>`;
}

function renderRowLoading(rowId) {
    const progress = getTaskStatusText(rowId);
    return `<span class="annotation-loading">
        <span class="loading-spinner"></span>
        <span>${escapeHtml(progress || '标注中')}</span>
    </span>`;
}

// 分页渲染
function renderPagination() {
    const container = document.getElementById('pagination');
    if (state.totalPages <= 1) {
        container.innerHTML = '';
        return;
    }

    let html = '';

    // 上一页
    html += `<button class="page-btn" onclick="goToPage(${state.currentPage - 1})" ${state.currentPage <= 1 ? 'disabled' : ''}>
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg>
    </button>`;

    // 页码按钮（最多显示7个）
    const maxVisible = 7;
    let startPage = Math.max(1, state.currentPage - Math.floor(maxVisible / 2));
    let endPage = Math.min(state.totalPages, startPage + maxVisible - 1);
    if (endPage - startPage < maxVisible - 1) {
        startPage = Math.max(1, endPage - maxVisible + 1);
    }

    if (startPage > 1) {
        html += `<button class="page-btn" onclick="goToPage(1)">1</button>`;
        if (startPage > 2) html += `<span class="px-1 text-gray-400">...</span>`;
    }

    for (let i = startPage; i <= endPage; i++) {
        html += `<button class="page-btn ${i === state.currentPage ? 'active' : ''}" onclick="goToPage(${i})">${i}</button>`;
    }

    if (endPage < state.totalPages) {
        if (endPage < state.totalPages - 1) html += `<span class="px-1 text-gray-400">...</span>`;
        html += `<button class="page-btn" onclick="goToPage(${state.totalPages})">${state.totalPages}</button>`;
    }

    // 下一页
    html += `<button class="page-btn" onclick="goToPage(${state.currentPage + 1})" ${state.currentPage >= state.totalPages ? 'disabled' : ''}>
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
    </button>`;

    container.innerHTML = html;
}

function goToPage(page) {
    if (page < 1 || page > state.totalPages) return;
    state.currentPage = page;
    loadRows();
}

function jumpToPage() {
    const input = document.getElementById('pageJumpInput');
    const page = parseInt(input && input.value, 10);
    if (!Number.isFinite(page)) return;
    goToPage(Math.max(1, Math.min(state.totalPages, page)));
}

function handlePageJumpKey(event) {
    if (event.key === 'Enter') jumpToPage();
}

function changePageSize(size) {
    state.pageSize = parseInt(size);
    state.currentPage = 1;
    loadRows();
}

function handleSearch(value) {
    clearTimeout(state._searchTimer);
    state._searchTimer = setTimeout(() => {
        state.search = value.trim();
        state.currentPage = 1;
        loadRows();
    }, 300);
}

function handleFilter(value) {
    state.filter = value;
    state.currentPage = 1;
    loadRows();
}

// ==================== 4. 标注模块（核心） ====================

const activeAnnotationJobs = new Map();

function getAnnotationJobKey(rowId, model, strategy) {
    return `${getComboName(model, strategy)}::${rowId}`;
}

function getCurrentRowJob(rowId) {
    return activeAnnotationJobs.get(getAnnotationJobKey(rowId, getCurrentModelValue(), getCurrentStrategyValue()));
}

async function cancelRowAnnotation(rowId) {
    const job = getCurrentRowJob(rowId);
    if (!job) return;
    if (!job.id || job.optimistic) {
        showToast('任务正在创建中，请稍后终止', 'warning');
        return;
    }
    try {
        await api(`/api/annotation-tasks/${encodeURIComponent(job.id)}/cancel`, { method: 'POST' });
        activeAnnotationJobs.delete(getAnnotationJobKey(rowId, getCurrentModelValue(), getCurrentStrategyValue()));
        renderTable();
        showToast(`已终止第 ${rowId} 行标注`, 'warning');
        pollAnnotationTasks(true);
    } catch (e) {
        console.error('终止任务失败', e);
    }
}

async function fetchAnnotationTaskSummary(combo = getCurrentComboName()) {
    if (!combo) return { pending: 0, running: 0, active: 0 };
    try {
        return await api(`/api/annotation-tasks/summary?model=${encodeURIComponent(combo)}`);
    } catch (e) {
        console.error('查询任务摘要失败', e);
        return { pending: 0, running: 0, active: 0 };
    }
}

async function openCancelPendingTasksConfirm() {
    hideToolbarMoreMenu();
    hideColumnPanel();
    const combo = getCurrentComboName();
    if (!combo) {
        showToast('请先选择模型和方案', 'warning');
        return;
    }
    const summary = await fetchAnnotationTaskSummary(combo);
    const pending = Number(summary.pending || 0);
    if (pending <= 0) {
        showToast('当前组合没有排队中的标注任务', 'warning');
        return;
    }
    state.pendingBulkAction = 'cancel_pending_tasks';
    state.pendingBulkIds = [];
    state.pendingCancelTaskCount = pending;
    const modal = document.getElementById('bulkConfirmModal');
    const title = document.getElementById('bulkConfirmTitle');
    const desc = document.getElementById('bulkConfirmDesc');
    const impact = document.getElementById('bulkConfirmImpact');
    const submit = document.getElementById('bulkConfirmSubmit');
    if (title) title.textContent = '确认取消剩下标注';
    if (desc) desc.textContent = '系统只会取消当前模型和方案下仍在排队中的标注任务，正在标注中的任务会继续执行。';
    if (impact) impact.textContent = `当前组合 ${combo} 有 ${pending} 个排队任务将被取消。`;
    if (submit) {
        submit.textContent = '确认取消';
        submit.classList.add('danger-confirm-btn');
    }
    if (modal) modal.classList.remove('hidden');
}

async function cancelCurrentComboPendingTasks() {
    const combo = getCurrentComboName();
    if (!combo) {
        showToast('请先选择模型和方案', 'warning');
        return;
    }
    const data = await api('/api/annotation-tasks/cancel-pending', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: combo })
    });
    if (!data.success) {
        showToast('取消失败：' + (data.message || '未知错误'), 'error');
        return;
    }
    Array.from(activeAnnotationJobs.entries()).forEach(([key, job]) => {
        if (key.startsWith(`${combo}::`) && job && job.status === 'pending') {
            activeAnnotationJobs.delete(key);
        }
    });
    showToast(`已取消当前组合 ${data.cancelled || 0} 个排队任务`, 'success');
    await pollAnnotationTasks(true);
    await refreshStatsPageIfVisible();
}

async function loadAllPrompts() {
    try {
        const data = await api('/api/prompts');
        const promptNames = data.prompts || data || [];
        const prompts = [];
        const loadPromises = promptNames.map(async (name) => {
            const pName = typeof name === 'string' ? name : (name.name || '');
            if (pName) {
                try {
                    const pData = await api(`/api/prompts/${encodeURIComponent(pName)}`);
                    prompts.push({ name: pName, content: pData.content || pData || '' });
                } catch (e) {
                    console.error(`加载Prompt ${pName} 失败`, e);
                }
            }
        });
        await Promise.all(loadPromises);
        // 同步到 state
        state.prompts = prompts.reduce((acc, item) => {
            acc[item.name] = item.content;
            return acc;
        }, {});
        return prompts;
    } catch (e) {
        console.error('加载Prompt列表失败', e);
        return { ...state.prompts };
    }
}

async function loadAllKnowledge() {
    try {
        const data = await api('/api/knowledge');
        const knowledgeNames = data.knowledge || data || [];
        const knowledge = [];
        const loadPromises = knowledgeNames.map(async (name) => {
            const kName = typeof name === 'string' ? name : (name.name || '');
            if (kName) {
                try {
                    const kData = await api(`/api/knowledge/${encodeURIComponent(kName)}`);
                    knowledge.push({ name: kName, content: kData.content || kData || '' });
                } catch (e) {
                    console.error(`加载知识 ${kName} 失败`, e);
                }
            }
        });
        await Promise.all(loadPromises);
        state.knowledge = knowledge.reduce((acc, item) => {
            acc[item.name] = item.content;
            return acc;
        }, {});
        return knowledge;
    } catch (e) {
        console.error('加载知识列表失败', e);
        return Object.entries(state.knowledge || {}).map(([name, content]) => ({ name, content }));
    }
}

async function annotateRow(rowId) {
    if (!getCurrentModelValue()) {
        showToast('请先选择模型', 'error');
        return;
    }

    // 找到当前行数据
    const row = state.rows.find(r => String(r.id || r._id) === String(rowId));
    if (!row) {
        showToast('未找到行数据', 'error');
        return;
    }

    const prompts = await loadAllPrompts();
    const knowledge = await loadAllKnowledge();
    runAnnotationQueue([row], prompts, '单条标注完成', { knowledge });
}

const bulkActionCopy = {
    annotate: {
        title: '确认批量标注',
        desc: '系统会为当前选中的数据创建当前模型和方案下的标注任务。',
        impact: count => `将标注 ${count} 条数据。已存在相同模型和方案任务的数据会由后台拦截，长时间任务会异步执行。`,
        danger: false,
    },
    clear_annotations: {
        title: '确认清空标注内容',
        desc: '系统会删除当前模型和方案下选中数据的标注结果。',
        impact: count => `将清空当前组合 ${getCurrentComboName()} 下 ${count} 条选中数据的标注结果，原始数据保留。`,
        danger: true,
    },
    clear_selection: {
        title: '确认清空选择',
        desc: '系统会取消当前页面和范围选择产生的选中状态。',
        impact: count => `将取消 ${count} 条数据的选中状态，数据和标注结果保留。`,
        danger: false,
    },
    delete: {
        title: '确认批量删除数据',
        desc: '系统会删除选中数据，并清理这些数据关联的全部模型方案标注结果和标注任务。',
        impact: count => `将删除 ${count} 条数据。若这些数据存在排队或执行中的标注任务，相关任务记录会一并清理。`,
        danger: true,
    },
};

async function openBulkActionConfirm(action) {
    hideBulkActionMenu();
    const ids = state.selectedRowIds.size > 0 ? [...state.selectedRowIds] : (hasActiveRangeSelection() ? await fetchRangeRowIds() : []);
    if (ids.length === 0) {
        showToast('请先选择数据', 'warning');
        return;
    }
    const copy = bulkActionCopy[action];
    if (!copy) return;
    state.pendingBulkAction = action;
    state.pendingBulkIds = ids;
    const modal = document.getElementById('bulkConfirmModal');
    const title = document.getElementById('bulkConfirmTitle');
    const desc = document.getElementById('bulkConfirmDesc');
    const impact = document.getElementById('bulkConfirmImpact');
    const submit = document.getElementById('bulkConfirmSubmit');
    if (title) title.textContent = copy.title;
    if (desc) desc.textContent = copy.desc;
    if (impact) impact.textContent = copy.impact(ids.length);
    if (submit) {
        submit.textContent = copy.danger ? '确认执行' : '确认';
        submit.classList.toggle('danger-confirm-btn', !!copy.danger);
    }
    if (modal) modal.classList.remove('hidden');
}

function closeBulkActionConfirm() {
    const modal = document.getElementById('bulkConfirmModal');
    if (modal) modal.classList.add('hidden');
    state.pendingBulkAction = '';
    state.pendingBulkIds = [];
    state.pendingCancelTaskCount = 0;
}

async function executeBulkActionConfirm() {
    const action = state.pendingBulkAction;
    const ids = [...state.pendingBulkIds];
    const submit = document.getElementById('bulkConfirmSubmit');
    if (submit) submit.disabled = true;
    try {
        if (action === 'annotate') {
            closeBulkActionConfirm();
            await batchAnnotate(ids);
        } else if (action === 'clear_annotations') {
            closeBulkActionConfirm();
            await clearSelectedAnnotations(true, ids);
        } else if (action === 'clear_selection') {
            closeBulkActionConfirm();
            clearRowSelection();
            showToast('已清空选择');
        } else if (action === 'delete') {
            closeBulkActionConfirm();
            await deleteSelectedRows(true, ids);
        } else if (action === 'cancel_pending_tasks') {
            closeBulkActionConfirm();
            await cancelCurrentComboPendingTasks();
        }
    } finally {
        if (submit) submit.disabled = false;
    }
}

async function batchAnnotate(targetIds = null) {
    if (!getCurrentModelValue()) {
        showToast('请先选择模型', 'error');
        return;
    }

    const ids = targetIds || [...state.selectedRowIds];
    if (ids.length === 0) {
        showToast('请先勾选要标注的数据', 'warning');
        return;
    }

    const rows = await fetchRowsByIds(ids);
    if (rows.length === 0) {
        showToast('选中的数据不存在或已删除', 'warning');
        return;
    }
    const prompts = await loadAllPrompts();
    const knowledge = await loadAllKnowledge();
    await runAnnotationQueue(rows, prompts, '选中项标注完成', {
        knowledge,
        blockWhenComboActive: ids.length >= state.total
    });
    clearRowSelection();
}

async function fetchRowsByIds(ids) {
    const data = await api('/api/rows/by-ids', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ row_ids: ids, model: getCurrentComboName() })
    });
    return data.rows || [];
}

async function deleteSelectedRows(confirmed = false, targetIds = null) {
    const ids = targetIds || [...state.selectedRowIds];
    if (ids.length === 0) {
        showToast('请先选择要删除的数据', 'warning');
        return;
    }
    await deleteRowsByIds(ids, confirmed);
}

async function deleteRowsByIds(ids, confirmed = false) {
    const rowIds = ids.map(id => parseInt(id, 10)).filter(Number.isFinite);
    if (rowIds.length === 0) {
        showToast('请选择要删除的数据', 'warning');
        return;
    }
    if (!confirmed && !confirm(`确定删除 ${rowIds.length} 条数据吗？删除后会清理这些数据的所有模型方案标注结果。`)) {
        return;
    }
    const data = await api('/api/rows', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ row_ids: rowIds, confirmed })
    });
    if (data.requires_confirmation) {
        const ok = confirm(`有 ${data.active_task_count || 0} 个任务正在标注或排队。确定删除这些数据并清理相关任务吗？`);
        if (ok) await deleteRowsByIds(rowIds, true);
        return;
    }
    if (!data.success) {
        showToast('删除失败：' + (data.message || '未知错误'), 'error');
        return;
    }
    rowIds.forEach(id => state.selectedRowIds.delete(String(id)));
    rowIds.forEach(id => {
        Array.from(activeAnnotationJobs.keys()).forEach(key => {
            if (key.endsWith(`::${id}`)) activeAnnotationJobs.delete(key);
        });
    });
    showToast(`已删除 ${data.deleted_rows || 0} 条数据`);
    await loadRows({ silent: true });
    await loadStats();
    refreshStatsPageIfVisible();
}

async function clearSelectedAnnotations(skipConfirm = false, targetIds = null) {
    const ids = (targetIds || [...state.selectedRowIds]).map(id => parseInt(id, 10)).filter(Number.isFinite);
    if (ids.length === 0) {
        showToast('请先勾选要清空标注的数据', 'warning');
        return;
    }
    const combo = getCurrentComboName();
    if (!skipConfirm && !confirm(`确定清空当前组合 ${combo} 下选中 ${ids.length} 条数据的标注内容吗？`)) return;
    try {
        const data = await api('/api/annotations', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ row_ids: ids, model_name: combo })
        });
        if (data.success) {
            showToast(`已清空 ${data.deleted || 0} 条标注`, 'success');
            clearRowSelection();
            await loadRows();
            await loadStats();
            refreshStatsPageIfVisible();
        } else {
            showToast('清空失败：' + (data.message || '未知错误'), 'error');
        }
    } catch (err) {
        showToast('清空失败：' + err.message, 'error');
    }
}

async function customFullAnnotate() {
    const model = getCurrentModelValue();
    const strategy = getCurrentStrategyValue();
    if (!model) {
        showToast('请先选择模型', 'warning');
        return;
    }
    if (!strategy) {
        showToast('请先选择方案', 'warning');
        return;
    }
    const btn = document.getElementById('customFullAnnotateBtn');
    try {
        if (btn) btn.disabled = true;
        showGlobalLoading('正在执行自定义全量标注...');
        const data = await api('/api/custom-full-annotate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model_config: model,
                strategy
            })
        });
        if (!data.success) {
            showToast(data.message || '自定义全量标注失败', 'error');
            return;
        }
        showToast(`自定义全量标注完成：${data.annotated || 0} 条`, 'success');
        await loadRows({ silent: true });
        await loadStats();
        refreshStatsPageIfVisible();
    } catch (err) {
        showToast('自定义全量标注失败：' + err.message, 'error');
    } finally {
        hideGlobalLoading();
        if (btn) btn.disabled = false;
    }
}

function buildAnnotateData(row) {
    const annotateData = {};
    if (state.rule.annotate_fields && state.rule.annotate_fields.length > 0) {
        state.rule.annotate_fields.forEach(field => {
            if (row.data && row.data[field] !== undefined) {
                annotateData[field] = row.data[field];
            }
        });
    } else if (row.data) {
        Object.assign(annotateData, row.data);
    }
    return annotateData;
}

function buildSingleAnnotatePayload(row, prompts, model, strategy) {
    model = model || getCurrentModelValue();
    strategy = strategy || getCurrentStrategyValue();
    const combo = getComboName(model, strategy);
    return {
        rows: [{ id: row.id || row._id, data: buildAnnotateData(row) }],
        model_config: model,
        prompts: prompts,
        strategy: strategy,
        concurrency: getComboConcurrency(combo),
        knowledge: []
    };
}

function buildBatchAnnotatePayload(rows, prompts, model, strategy, knowledge = []) {
    model = model || getCurrentModelValue();
    strategy = strategy || getCurrentStrategyValue();
    const combo = getComboName(model, strategy);
    return {
        rows: rows.map(row => ({ id: row.id || row._id, data: buildAnnotateData(row) })),
        model_config: model,
        prompts: prompts,
        strategy: strategy,
        concurrency: getComboConcurrency(combo),
        knowledge: knowledge
    };
}

async function runAnnotationQueue(rows, prompts, doneMessage, options = {}) {
    const target = `${(options.model || getCurrentModelValue()).replace('.yaml', '')}(${options.strategy || getCurrentStrategyValue()})`;
    const queueMap = options.queueScope === 'combo' ? state.comboQueues : null;
    if (queueMap && queueMap[target]?.active) {
        showToast(`${target} 已在标注中`, 'warning');
        return false;
    }

    const model = options.model || getCurrentModelValue();
    const strategy = options.strategy || getCurrentStrategyValue();
    const runnableRows = rows.filter(row => {
        const rowId = row.id || row._id;
        return !activeAnnotationJobs.has(getAnnotationJobKey(rowId, model, strategy));
    });
    let skipped = rows.length - runnableRows.length;
    if (runnableRows.length === 0) {
        showToast(skipped > 0 ? '选中数据都在标注中' : '无数据可标注', 'warning');
        return false;
    }
    if (skipped > 0) showToast(`已跳过 ${skipped} 条正在标注的数据`, 'warning');
    const combo = getComboName(model, strategy);
    const existingSummary = await fetchAnnotationTaskSummary(combo);
    if ((existingSummary.active || 0) > 0) {
        const message = `当前组合已有 ${existingSummary.running || 0} 个标注中、${existingSummary.pending || 0} 个排队中任务`;
        if (options.blockWhenComboActive) {
            showToast(`${message}，请等待完成或先取消剩下标注`, 'warning');
            return false;
        }
        showToast(`${message}，本次会由后台跳过重复任务`, 'warning');
    }

    const queueState = { active: true, done: 0, total: runnableRows.length, target };
    if (queueMap) {
        queueMap[target] = queueState;
    } else {
        state.annotationQueue = queueState;
    }
    try {
        const concurrency = getComboConcurrency(target);
        runnableRows.forEach(row => {
            const rowId = row.id || row._id;
            activeAnnotationJobs.set(getAnnotationJobKey(rowId, model, strategy), {
                row_id: rowId,
                model_config: model,
                strategy,
                model_name: getComboName(model, strategy),
                status: 'creating',
                optimistic: true
            });
        });
        renderTable();
        if (typeof options.onProgress === 'function') {
            options.onProgress(`创建任务 0/${runnableRows.length}`);
        }
        const data = await api('/api/annotate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(buildBatchAnnotatePayload(runnableRows, prompts, model, strategy, options.knowledge || []))
        });
        const tasks = data.tasks || [];
        const returnedTaskKeys = new Set();
        tasks.forEach(task => {
            const key = getAnnotationJobKey(task.row_id, model, strategy);
            returnedTaskKeys.add(key);
            activeAnnotationJobs.set(key, task);
        });
        (data.errors || []).forEach(item => {
            if (item && item.task) {
                const task = item.task;
                const key = getAnnotationJobKey(task.row_id, task.model_config || model, task.strategy || strategy);
                returnedTaskKeys.add(key);
                activeAnnotationJobs.set(key, task);
            }
        });
        runnableRows.forEach(row => {
            const rowId = row.id || row._id;
            const key = getAnnotationJobKey(rowId, model, strategy);
            const optimisticJob = activeAnnotationJobs.get(key);
            if (optimisticJob && optimisticJob.optimistic && !returnedTaskKeys.has(key)) {
                activeAnnotationJobs.delete(key);
            }
        });
        queueState.done = tasks.length;
        if (typeof options.onProgress === 'function') {
            options.onProgress(`${tasks.length}/${runnableRows.length}`);
        }
        renderTable();
        startTaskPolling();
        if ((data.errors || []).length > 0) {
            showToast(`${doneMessage}：创建 ${tasks.length} 个任务，失败 ${data.errors.length} 条`, 'warning');
            return false;
        }
        showToast(`${doneMessage}：已创建 ${tasks.length} 个任务，并发 ${concurrency}`, 'success');
        return true;
    } finally {
        runnableRows.forEach(row => {
            const rowId = row.id || row._id;
            const key = getAnnotationJobKey(rowId, model, strategy);
            const optimisticJob = activeAnnotationJobs.get(key);
            if (optimisticJob && optimisticJob.optimistic) activeAnnotationJobs.delete(key);
        });
        if (queueMap) {
            delete queueMap[target];
        } else {
            state.annotationQueue = { active: false, done: 0, total: 0, target: '' };
        }
        if (typeof options.onProgress === 'function') {
            options.onProgress('');
        }
    }
}

function startTaskPolling() {
    if (state.taskPollTimer) clearInterval(state.taskPollTimer);
    state.taskPollTimer = setInterval(() => pollAnnotationTasks(false), 2000);
    pollAnnotationTasks(false);
}

async function pollAnnotationTasks(forceRefresh) {
    const combo = getCurrentComboName();
    if (!combo) return;
    try {
        const rowIds = state.rows.map(row => row.id || row._id).filter(Boolean).join(',');
        const rowParam = rowIds ? `&row_ids=${encodeURIComponent(rowIds)}` : '';
        const data = await api(`/api/annotation-tasks?model=${encodeURIComponent(combo)}&active_only=true${rowParam}`);
        const tasks = data.tasks || [];
        const nextKeys = {};
        Array.from(activeAnnotationJobs.keys()).forEach(key => {
            if (key.startsWith(`${combo}::`)) {
                const job = activeAnnotationJobs.get(key);
                if (!job || !job.optimistic) activeAnnotationJobs.delete(key);
            }
        });
        tasks.forEach(task => {
            const key = getAnnotationJobKey(task.row_id, task.model_config, task.strategy);
            activeAnnotationJobs.set(key, task);
            nextKeys[key] = task.status;
        });

        const prevKeys = Object.keys(state.activeTaskSnapshot || {});
        const activeChanged = prevKeys.length !== Object.keys(nextKeys).length
            || prevKeys.some(key => !nextKeys[key] || nextKeys[key] !== state.activeTaskSnapshot[key]);
        state.activeTaskSnapshot = nextKeys;

        if (forceRefresh || activeChanged) {
            await Promise.all([
                loadRows({ silent: true }),
                loadStats(),
                refreshStatsPageIfVisible()
            ]);
        } else {
            renderTable();
        }
    } catch (e) {
        console.error('查询任务状态失败', e);
    }
}

// ==================== 4.1 清理全部数据 ====================
function openClearDataConfirm() {
    if (state.total <= 0) {
        showToast('暂无数据可删除', 'warning');
        return;
    }
    resetClearDataSlider();
    const modal = document.getElementById('clearDataModal');
    if (modal) modal.classList.remove('hidden');
}

function closeClearDataConfirm() {
    const modal = document.getElementById('clearDataModal');
    if (modal) modal.classList.add('hidden');
    resetClearDataSlider();
}

function resetClearDataSlider() {
    state.clearSlide.dragging = false;
    state.clearSlide.confirmed = false;
    const track = document.getElementById('clearSlideTrack');
    const fill = document.getElementById('clearSlideFill');
    const thumb = document.getElementById('clearSlideThumb');
    if (track) track.classList.remove('clear-slide-complete', 'clear-slide-working');
    if (fill) fill.style.width = '0px';
    if (thumb) {
        thumb.style.transform = 'translateX(0px)';
        thumb.textContent = '删除';
        thumb.disabled = false;
    }
}

function initClearDataSlider() {
    const track = document.getElementById('clearSlideTrack');
    const thumb = document.getElementById('clearSlideThumb');
    if (!track || !thumb) return;

    const moveToClientX = (clientX) => {
        if (!state.clearSlide.dragging || state.clearSlide.confirmed) return;
        const rect = track.getBoundingClientRect();
        const thumbWidth = thumb.offsetWidth || 72;
        const max = Math.max(0, rect.width - thumbWidth - 6);
        const x = Math.max(0, Math.min(max, clientX - rect.left - thumbWidth / 2));
        thumb.style.transform = `translateX(${x}px)`;
        const fill = document.getElementById('clearSlideFill');
        if (fill) fill.style.width = `${x + thumbWidth}px`;
        if (x >= max * 0.96) {
            state.clearSlide.confirmed = true;
            state.clearSlide.dragging = false;
            track.classList.add('clear-slide-complete', 'clear-slide-working');
            thumb.textContent = '执行中';
            thumb.disabled = true;
            executeClearAllData();
        }
    };

    thumb.addEventListener('pointerdown', (event) => {
        if (state.clearSlide.confirmed || thumb.disabled) return;
        state.clearSlide.dragging = true;
        thumb.setPointerCapture(event.pointerId);
        moveToClientX(event.clientX);
    });
    thumb.addEventListener('pointermove', (event) => moveToClientX(event.clientX));
    thumb.addEventListener('pointerup', (event) => {
        if (thumb.hasPointerCapture(event.pointerId)) thumb.releasePointerCapture(event.pointerId);
        if (state.clearSlide.dragging && !state.clearSlide.confirmed) resetClearDataSlider();
    });
    thumb.addEventListener('pointercancel', () => {
        if (!state.clearSlide.confirmed) resetClearDataSlider();
    });
}

async function executeClearAllData() {
    if (state.total <= 0) {
        showToast('暂无数据可删除', 'warning');
        closeClearDataConfirm();
        return;
    }
    try {
        const data = await api('/api/clear', { method: 'DELETE' });
        if (data.success) {
            showToast(data.message, 'success');
            closeClearDataConfirm();
            state.selectedRowIds.clear();
            activeAnnotationJobs.clear();
            await loadRows();
            await loadStats();
            refreshStatsPageIfVisible();
        } else {
            showToast('清理失败：' + data.message, 'error');
            resetClearDataSlider();
        }
    } catch (err) {
        showToast('清理失败：' + err.message, 'error');
        resetClearDataSlider();
    }
}

async function clearAllData() {
    openClearDataConfirm();
}

// ==================== 4.2 标注全部数据 ====================
async function annotateAll() {
    if (!getCurrentModelValue()) {
        showToast('请先选择模型', 'warning');
        return;
    }

    try {
        setBulkAnnotateStatus('正在加载 Prompt 和知识...');
        const prompts = await loadAllPrompts();
        const knowledge = await loadAllKnowledge();
        setBulkAnnotateStatus('正在获取全部数据...');
        showToast('正在获取全部数据...', 'warning');
        // 获取所有行数据
        const allData = await api('/api/rows?page=1&page_size=100000');
        const rows = allData.rows || [];

        if (rows.length === 0) {
            showToast('无数据可标注', 'warning');
            return;
        }

        await runAnnotationQueue(rows, prompts, '全部标注完成', {
            knowledge,
            onProgress: (text) => setBulkAnnotateStatus(text ? `${text}` : '')
        });
    } catch (err) {
        showToast('标注失败：' + err.message, 'error');
    } finally {
        setBulkAnnotateStatus('');
    }
}

function getModelNames() {
    return state.models
        .map(m => typeof m === 'string' ? m : (m.name || m.model_name || ''))
        .filter(Boolean);
}

function getComboName(modelFile, strategyName) {
    return `${modelFile.replace('.yaml', '')}(${strategyName})`;
}

function clampConcurrency(value) {
    return Math.min(20, Math.max(1, parseInt(value, 10) || 1));
}

function getComboConcurrency(comboName) {
    return clampConcurrency(state.comboConcurrency[comboName] || state.settings.default_concurrency || 1);
}

function setComboConcurrency(comboName, value) {
    const count = clampConcurrency(value);
    state.comboConcurrency[comboName] = count;
    localStorage.setItem('comboConcurrency', JSON.stringify(state.comboConcurrency));
    if (comboName === getCurrentComboName()) syncConcurrencyInput();
    return count;
}

function setCurrentConcurrency(value) {
    const combo = getCurrentComboName();
    if (!combo) return;
    setComboConcurrency(combo, value);
    refreshStatsPageIfVisible();
}

function syncConcurrencyInput() {
    const input = document.getElementById('concurrencyInput');
    const combo = getCurrentComboName();
    if (input && combo) input.value = getComboConcurrency(combo);
}

async function loadAllRowsForAnnotation() {
    const allData = await api('/api/rows?page=1&page_size=100000');
    return allData.rows || [];
}

async function refreshStatsPageIfVisible() {
    const page = document.getElementById('pageStats');
    if (page && !page.classList.contains('hidden')) {
        await refreshStatsPage();
    }
}

async function refreshStatsPage() {
    const grid = document.getElementById('comboStatsGrid');
    if (!grid) return;
    const models = getModelNames();
    const strategies = state.strategies || [];
    if (models.length === 0 || strategies.length === 0) {
        grid.innerHTML = '<div class="text-sm text-gray-500">暂无模型或方案</div>';
        return;
    }

    grid.innerHTML = '<div class="stats-loading"><span class="loading-spinner"></span><span>正在加载组合统计...</span></div>';
    const statsMap = {};
    await Promise.all(models.flatMap(model => strategies.map(async strategy => {
        const combo = getComboName(model, strategy);
        statsMap[combo] = await api(`/api/stats?model=${encodeURIComponent(combo)}`);
    })));

    const modelSections = [];
    for (const model of models) {
        const cards = [];
        for (const strategy of strategies) {
            const combo = getComboName(model, strategy);
            const data = statsMap[combo] || {};
            cards.push(renderStatsCard(model, strategy, combo, data));
        }
        const modelCombos = strategies.map(strategy => getComboName(model, strategy));
        const allModelSelected = modelCombos.every(combo => state.selectedCombos.has(combo));
        modelSections.push(`<section class="model-stats-panel">
            <div class="model-stats-head">
                <div>
                    <div class="model-stats-title">${escapeHtml(model.replace('.yaml', ''))}</div>
                    <div class="model-stats-subtitle">${strategies.length} 个标注方案</div>
                </div>
                <label class="model-select-all">
                    <input type="checkbox" onchange="toggleModelCombos('${escapeJs(model)}', this.checked)" ${allModelSelected ? 'checked' : ''}>
                    全选该模型方案
                </label>
            </div>
            <div class="strategy-stats-grid">${cards.join('')}</div>
        </section>`);
    }
    grid.innerHTML = modelSections.join('');
    applyMetricHelpTitles();
    updateComboSelectionSummary();
}

function renderStatsCard(model, strategy, combo, data) {
    const progressId = `progress_${combo.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const timer = getComboTimer(combo);
    const timerStatus = timer && timer.enabled ? `已设置：${timer.time} 一次性触发` : '未设置定时';
    const safeCombo = escapeJs(combo);
    const selected = state.selectedCombos.has(combo);
    const running = !!state.comboQueues[combo]?.active;
    const f1Value = data.f1_score !== undefined && data.f1_score !== null
        ? data.f1_score
        : calcF1Score(data.tp || 0, data.fp || 0, data.fn || 0);
    return `<div class="combo-card ${selected ? 'combo-card-selected' : ''}">
        <div class="combo-card-head">
            <div>
                <label class="combo-select-line">
                    <input type="checkbox" onchange="toggleComboSelection('${safeCombo}', this.checked)" ${selected ? 'checked' : ''}>
                    <span class="combo-title">${escapeHtml(strategy)}</span>
                </label>
                <div class="combo-subtitle">${escapeHtml(combo)}</div>
            </div>
            <div class="combo-card-actions">
                <button class="combo-export-btn" onclick="exportComboData('${safeCombo}')">导出</button>
                <button class="combo-annotate-btn" onclick="annotateComboAll('${escapeJs(model)}', '${escapeJs(strategy)}', '${escapeJs(progressId)}')" ${running ? 'disabled' : ''}>${running ? '标注中' : '全量标注'}</button>
            </div>
        </div>
        <div class="combo-counts">
            ${renderStatsMetricItem('总量', data.total || 0, statHelpText.total)}
            ${renderStatsMetricItem('已标注', data.annotated || 0, statHelpText.annotated)}
            ${renderStatsMetricItem('TP', data.tp || 0, statHelpText.tp)}
            ${renderStatsMetricItem('TN', data.tn || 0, statHelpText.tn)}
            ${renderStatsMetricItem('FP', data.fp || 0, statHelpText.fp)}
            ${renderStatsMetricItem('FN', data.fn || 0, statHelpText.fn)}
        </div>
        <div class="combo-rates">
            ${renderStatsMetricItem('正确查全率', formatPercent(data.positive_recall), statHelpText.positive_recall)}
            ${renderStatsMetricItem('错误查全率', formatPercent(data.negative_recall), statHelpText.negative_recall)}
            ${renderStatsMetricItem('正确查准率', formatPercent(data.positive_precision), statHelpText.positive_precision)}
            ${renderStatsMetricItem('F1 Score', formatPercent(f1Value), statHelpText.f1_score)}
            ${renderStatsMetricItem('错误查准率', formatPercent(data.negative_precision), statHelpText.negative_precision)}
            ${renderStatsMetricItem('算法准确率', formatPercent(data.accuracy), statHelpText.accuracy)}
        </div>
        <div class="combo-config">
            <label>并发数 <input type="number" min="1" max="20" value="${getComboConcurrency(combo)}" oninput="setComboConcurrency('${safeCombo}', this.value)" onchange="setComboConcurrency('${safeCombo}', this.value); refreshStatsPageIfVisible();"></label>
        </div>
        <div class="combo-schedule">
            <div class="combo-schedule-status" id="timer_status_${escapeHtml(progressId)}">${escapeHtml(timerStatus)}</div>
            <div class="combo-schedule-controls">
                <input id="timer_input_${escapeHtml(progressId)}" type="time" value="${escapeHtml(timer ? timer.time : '02:00')}">
                <button class="flat-btn primary" onclick="saveComboTimer('${escapeJs(model)}', '${escapeJs(strategy)}', 'timer_input_${escapeJs(progressId)}')">定时一次</button>
                <button class="flat-btn muted" onclick="cancelComboTimer('${safeCombo}')">取消</button>
            </div>
        </div>
        <div id="${escapeHtml(progressId)}" class="combo-progress"></div>
    </div>`;
}

function renderStatsMetricItem(label, value, tooltip) {
    return `<span class="metric-help stats-chip ${getStatsToneClass(label)}" data-tooltip="${escapeHtml(tooltip || '')}">
        <span>${escapeHtml(label)}</span>
        <b>${escapeHtml(value)}</b>
    </span>`;
}

async function annotateComboAll(model, strategy, progressId) {
    const combo = getComboName(model, strategy);
    if (state.comboQueues[combo]?.active) {
        showToast(`${combo} 已在标注中`, 'warning');
        return false;
    }
    const prompts = await loadAllPrompts();
    const knowledge = await loadAllKnowledge();
    const rows = await loadAllRowsForAnnotation();
    const progressEl = document.getElementById(progressId);
    const started = await runAnnotationQueue(rows, prompts, `${combo} 全量标注完成`, {
        model,
        strategy,
        knowledge,
        queueScope: 'combo',
        blockWhenComboActive: true,
        deferStatsPageRefresh: true,
        onProgress: (text) => {
            if (progressEl) {
                progressEl.textContent = text ? `标注进度 ${text}` : '';
            }
        }
    });
    await refreshStatsPage();
    return started;
}

function toggleComboSelection(combo, checked) {
    if (checked) {
        state.selectedCombos.add(combo);
    } else {
        state.selectedCombos.delete(combo);
    }
    refreshStatsPage();
}

function toggleModelCombos(model, checked) {
    (state.strategies || []).forEach(strategy => {
        const combo = getComboName(model, strategy);
        if (checked) {
            state.selectedCombos.add(combo);
        } else {
            state.selectedCombos.delete(combo);
        }
    });
    refreshStatsPage();
}

function clearComboSelection() {
    state.selectedCombos.clear();
    refreshStatsPage();
}

function updateComboSelectionSummary() {
    const count = state.selectedCombos.size;
    const panel = document.getElementById('comboBatchActions');
    const countEl = document.getElementById('selectedComboCount');
    if (countEl) countEl.textContent = count;
    if (panel) panel.classList.toggle('hidden', count === 0);
}

function parseComboName(combo) {
    const idx = combo.lastIndexOf('(');
    if (idx < 0 || !combo.endsWith(')')) return null;
    return {
        model: `${combo.slice(0, idx)}.yaml`,
        strategy: combo.slice(idx + 1, -1),
    };
}

async function annotateSelectedCombos() {
    const combos = [...state.selectedCombos];
    if (combos.length === 0) {
        showToast('请先选择要标注的组合', 'warning');
        return;
    }
    const progress = document.getElementById('comboBatchProgress');
    const prompts = await loadAllPrompts();
    const knowledge = await loadAllKnowledge();
    const rows = await loadAllRowsForAnnotation();

    for (let i = 0; i < combos.length; i += 1) {
        const combo = combos[i];
        const parsed = parseComboName(combo);
        if (!parsed) continue;
        if (progress) progress.textContent = `正在标注 ${i + 1}/${combos.length}：${combo}`;
        await runAnnotationQueue(rows, prompts, `${combo} 全量标注完成`, {
            model: parsed.model,
            strategy: parsed.strategy,
            knowledge,
            queueScope: 'combo',
            blockWhenComboActive: true,
            deferStatsPageRefresh: true,
            onProgress: (text) => {
                if (progress) progress.textContent = text ? `正在标注 ${i + 1}/${combos.length}：${combo} ${text}` : '';
            }
        });
    }
    state.selectedCombos.clear();
    if (progress) progress.textContent = '';
    await refreshStatsPage();
    await loadStats();
}

function initNightAutoAnnotate() {
    initComboTimers();
}

function saveNightAutoAnnotate() {
}

function disableNightAutoAnnotate() {
}

function scheduleNightAutoAnnotate(time) {
}

function getComboTimers() {
    return JSON.parse(localStorage.getItem('comboTimers') || '{}');
}

function setComboTimers(timers) {
    localStorage.setItem('comboTimers', JSON.stringify(timers));
}

function getComboTimer(combo) {
    return getComboTimers()[combo] || null;
}

function initComboTimers() {
    Object.values(state.comboTimers).forEach(timerId => clearTimeout(timerId));
    state.comboTimers = {};
    const timers = getComboTimers();
    Object.entries(timers).forEach(([combo, timer]) => {
        if (timer && timer.enabled) scheduleComboTimer(combo, timer.model, timer.strategy, timer.time, false);
    });
}

function saveComboTimer(model, strategy, inputId) {
    const combo = getComboName(model, strategy);
    const input = document.getElementById(inputId);
    const time = (input && input.value) || '02:00';
    const timers = getComboTimers();
    timers[combo] = { enabled: true, model, strategy, time };
    setComboTimers(timers);
    scheduleComboTimer(combo, model, strategy, time, true);
    refreshStatsPageIfVisible();
}

function cancelComboTimer(combo) {
    const timers = getComboTimers();
    delete timers[combo];
    setComboTimers(timers);
    if (state.comboTimers[combo]) {
        clearTimeout(state.comboTimers[combo]);
        delete state.comboTimers[combo];
    }
    showToast(`${combo} 定时已取消`);
    refreshStatsPageIfVisible();
}

function scheduleComboTimer(combo, model, strategy, time, notify) {
    if (state.comboTimers[combo]) clearTimeout(state.comboTimers[combo]);
    const [hour, minute] = time.split(':').map(n => parseInt(n, 10));
    const now = new Date();
    const next = new Date();
    next.setHours(hour || 0, minute || 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const delayMs = next.getTime() - now.getTime();
    state.comboTimers[combo] = setTimeout(async () => {
        showToast(`${combo} 定时标注开始`, 'warning');
        await annotateComboAll(model, strategy, `progress_${combo.replace(/[^a-zA-Z0-9]/g, '_')}`);
        const timers = getComboTimers();
        delete timers[combo];
        setComboTimers(timers);
        delete state.comboTimers[combo];
        refreshStatsPageIfVisible();
    }, delayMs);
    if (notify) showToast(`${combo} 已设置 ${formatDateTime(next)} 一次性标注`, 'success');
}

function updateNightAutoStatus(text) {
}

function formatDateTime(date) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// ==================== 5. 统计模块 ====================
async function loadStats() {
    renderStatsOverviewLoading();
    try {
        const comboName = getCurrentComboName();
        const statsUrl = comboName ? `/api/stats?model=${encodeURIComponent(comboName)}` : '/api/stats';
        const taskSummaryUrl = comboName ? `/api/annotation-tasks/summary?model=${encodeURIComponent(comboName)}` : '/api/annotation-tasks/summary';
        const [data, taskSummary] = await Promise.all([
            api(statsUrl),
            api(taskSummaryUrl),
        ]);
        renderStatsOverview(data, taskSummary);
    } catch (e) {
        console.error('加载统计失败', e);
        renderStatsOverview({
            total: 0,
            annotated: 0,
            tp: 0,
            fn: 0,
            fp: 0,
            tn: 0,
            accuracy: null,
            positive_recall: null,
            negative_recall: null,
            positive_precision: null,
            negative_precision: null,
            f1_score: null,
        }, {
            pending: 0,
            running: 0,
            success: 0,
            failed: 0,
            cancelled: 0,
        });
    }
}

// ==================== 6. Prompt 管理模块 ====================
async function loadPromptList(selectName) {
    try {
        const data = await api('/api/prompts');
        const promptNames = data.prompts || data || [];
        renderPromptList(promptNames);
        // 默认选中指定文件或第一个文件
        const resolvedNames = promptNames.map(n => typeof n === 'string' ? n : (n.name || '')).filter(Boolean);
        if (selectName && resolvedNames.includes(selectName)) {
            selectPromptFile(selectName);
        } else if (resolvedNames.length > 0 && !state.currentPromptFile) {
            selectPromptFile(resolvedNames[0]);
        }
    } catch (e) {
        console.error('加载Prompt列表失败', e);
    }
}

function renderPromptList(names) {
    const container = document.getElementById('promptList');
    container.innerHTML = '';
    names.forEach(name => {
        const pName = typeof name === 'string' ? name : (name.name || '');
        if (!pName) return;
        const div = document.createElement('div');
        div.className = `file-item ${state.currentPromptFile === pName ? 'active' : ''}`;
        div.textContent = pName;
        div.onclick = () => selectPromptFile(pName);
        container.appendChild(div);
    });
}

async function selectPromptFile(name) {
    state.currentPromptFile = name;
    state._isNewPrompt = false;
    document.getElementById('currentPromptName').textContent = name;
    document.getElementById('promptFileNameRow').classList.add('hidden');
    document.getElementById('promptFileNameInput').value = '';

    // 更新选中样式
    document.querySelectorAll('#promptList .file-item').forEach(el => {
        el.classList.toggle('active', el.textContent === name);
    });

    try {
        const data = await api(`/api/prompts/${encodeURIComponent(name)}`);
        const content = data.content || (typeof data === 'string' ? data : '');
        document.getElementById('promptEditor').value = content;
        updateCodePreview('prompt');
        state.prompts[name] = content;
    } catch (e) {
        console.error('加载Prompt内容失败', e);
    }
}

function newPrompt() {
    state.currentPromptFile = '';
    state._isNewPrompt = true;
    document.getElementById('currentPromptName').textContent = '新建文件';
    document.getElementById('promptEditor').value = '';
    updateCodePreview('prompt');
    document.getElementById('promptFileNameRow').classList.remove('hidden');
    document.getElementById('promptFileNameInput').value = '';
    document.getElementById('promptFileNameInput').focus();

    // 取消所有选中
    document.querySelectorAll('#promptList .file-item').forEach(el => {
        el.classList.remove('active');
    });
}

async function savePrompt() {
    let name = state.currentPromptFile;

    // 新增模式：从输入框获取文件名
    if (state._isNewPrompt) {
        name = document.getElementById('promptFileNameInput').value.trim();
        if (!name) {
            showToast('请输入文件名', 'warning');
            document.getElementById('promptFileNameInput').focus();
            return;
        }
    }

    if (!name) {
        showToast('请先选择一个Prompt文件', 'warning');
        return;
    }

    const content = document.getElementById('promptEditor').value;
    try {
        await api(`/api/prompts/${encodeURIComponent(name)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: content })
        });
        state.prompts[name] = content;
        showToast('Prompt 保存成功');

        // 新增模式保存后刷新列表并选中新文件
        if (state._isNewPrompt) {
            state._isNewPrompt = false;
            state.currentPromptFile = name;
            await loadPromptList(name);
        }
    } catch (e) {
        console.error('保存Prompt失败', e);
    }
}

// ==================== 7. 知识管理模块 ====================
async function loadKnowledgeList(selectName) {
    try {
        const data = await api('/api/knowledge');
        const knowledgeNames = data.knowledge || data || [];
        renderKnowledgeList(knowledgeNames);
        const resolvedNames = knowledgeNames.map(n => typeof n === 'string' ? n : (n.name || '')).filter(Boolean);
        if (selectName && resolvedNames.includes(selectName)) {
            selectKnowledgeFile(selectName);
        } else if (resolvedNames.length > 0 && !state.currentKnowledgeFile) {
            selectKnowledgeFile(resolvedNames[0]);
        }
    } catch (e) {
        console.error('加载知识列表失败', e);
    }
}

function renderKnowledgeList(names) {
    const container = document.getElementById('knowledgeList');
    if (!container) return;
    container.innerHTML = '';
    names.forEach(name => {
        const kName = typeof name === 'string' ? name : (name.name || '');
        if (!kName) return;
        const div = document.createElement('div');
        div.className = `file-item ${state.currentKnowledgeFile === kName ? 'active' : ''}`;
        div.textContent = kName;
        div.onclick = () => selectKnowledgeFile(kName);
        container.appendChild(div);
    });
}

async function selectKnowledgeFile(name) {
    state.currentKnowledgeFile = name;
    state._isNewKnowledge = false;
    document.getElementById('currentKnowledgeName').textContent = name;
    document.getElementById('knowledgeFileNameRow').classList.add('hidden');
    document.getElementById('knowledgeFileNameInput').value = '';

    document.querySelectorAll('#knowledgeList .file-item').forEach(el => {
        el.classList.toggle('active', el.textContent === name);
    });

    try {
        const data = await api(`/api/knowledge/${encodeURIComponent(name)}`);
        const content = data.content || (typeof data === 'string' ? data : '');
        document.getElementById('knowledgeEditor').value = content;
        updateCodePreview('knowledge');
        state.knowledge[name] = content;
    } catch (e) {
        console.error('加载知识内容失败', e);
    }
}

function newKnowledge() {
    state.currentKnowledgeFile = '';
    state._isNewKnowledge = true;
    document.getElementById('currentKnowledgeName').textContent = '新建文件';
    document.getElementById('knowledgeEditor').value = '';
    updateCodePreview('knowledge');
    document.getElementById('knowledgeFileNameRow').classList.remove('hidden');
    document.getElementById('knowledgeFileNameInput').value = '';
    document.getElementById('knowledgeFileNameInput').focus();

    document.querySelectorAll('#knowledgeList .file-item').forEach(el => {
        el.classList.remove('active');
    });
}

async function saveKnowledge() {
    let name = state.currentKnowledgeFile;

    if (state._isNewKnowledge) {
        name = document.getElementById('knowledgeFileNameInput').value.trim();
        if (!name) {
            showToast('请输入文件名', 'warning');
            document.getElementById('knowledgeFileNameInput').focus();
            return;
        }
    }

    if (!name) {
        showToast('请先选择一个知识文件', 'warning');
        return;
    }
    if (!/\.(json|jsonl|txt)$/i.test(name)) {
        showToast('知识文件仅支持 .json、.jsonl、.txt', 'warning');
        return;
    }

    const content = document.getElementById('knowledgeEditor').value;
    try {
        await api(`/api/knowledge/${encodeURIComponent(name)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: content })
        });
        state.knowledge[name] = content;
        showToast('知识文件保存成功');

        if (state._isNewKnowledge) {
            state._isNewKnowledge = false;
            state.currentKnowledgeFile = name;
            await loadKnowledgeList(name);
        }
    } catch (e) {
        console.error('保存知识失败', e);
        showToast('保存知识失败：' + e.message, 'error');
    }
}

// ==================== 8. 模型管理模块 ====================
function renderModelList(selectName) {
    const container = document.getElementById('modelList');
    container.innerHTML = '';
    state.models.forEach(m => {
        const name = typeof m === 'string' ? m : (m.name || m.model_name || '');
        if (!name) return;
        const div = document.createElement('div');
        div.className = `file-item ${state.currentModelFile === name ? 'active' : ''}`;
        div.textContent = name;
        div.onclick = () => selectModelFile(name);
        container.appendChild(div);
    });

    // 默认选中指定文件或第一个文件
    const resolvedNames = state.models.map(m => typeof m === 'string' ? m : (m.name || m.model_name || '')).filter(Boolean);
    if (selectName && resolvedNames.includes(selectName)) {
        selectModelFile(selectName);
    } else if (resolvedNames.length > 0 && !state.currentModelFile) {
        selectModelFile(resolvedNames[0]);
    }
}

async function selectModelFile(name) {
    state.currentModelFile = name;
    state._isNewModel = false;
    document.getElementById('currentModelName').textContent = name;
    document.getElementById('modelFileNameRow').classList.add('hidden');
    document.getElementById('modelFileNameInput').value = '';

    // 更新选中样式
    document.querySelectorAll('#modelList .file-item').forEach(el => {
        el.classList.toggle('active', el.textContent === name);
    });

    try {
        const data = await api(`/api/models/${encodeURIComponent(name)}`);
        // 模型配置一般是 YAML，直接显示文本
        const content = data.content || data.yaml || (typeof data === 'string' ? data : JSON.stringify(data, null, 2));
        document.getElementById('modelEditor').value = content;
        updateCodePreview('model');
    } catch (e) {
        console.error('加载模型配置失败', e);
    }
}

function newModel() {
    state.currentModelFile = '';
    state._isNewModel = true;
    document.getElementById('currentModelName').textContent = '新建文件';
    document.getElementById('modelEditor').value = '';
    updateCodePreview('model');
    document.getElementById('modelFileNameRow').classList.remove('hidden');
    document.getElementById('modelFileNameInput').value = '';
    document.getElementById('modelFileNameInput').focus();

    // 取消所有选中
    document.querySelectorAll('#modelList .file-item').forEach(el => {
        el.classList.remove('active');
    });
}

async function saveModel() {
    let name = state.currentModelFile;

    // 新增模式：从输入框获取文件名
    if (state._isNewModel) {
        name = document.getElementById('modelFileNameInput').value.trim();
        if (!name) {
            showToast('请输入文件名', 'warning');
            document.getElementById('modelFileNameInput').focus();
            return;
        }
        if (!name.endsWith('.yaml')) name = `${name}.yaml`;
    }

    if (!name) {
        showToast('请先选择一个模型配置文件', 'warning');
        return;
    }

    const content = document.getElementById('modelEditor').value;
    try {
        await api(`/api/models/${encodeURIComponent(name)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: content })
        });
        showToast('模型配置保存成功');

        // 新增模式保存后刷新列表并选中新文件
        if (state._isNewModel) {
            state._isNewModel = false;
            state.currentModelFile = name;
        }

        // 刷新模型列表
        await loadModels(name);
    } catch (e) {
        console.error('保存模型配置失败', e);
    }
}

// ==================== 8. 导出模块 ====================
async function exportData() {
    const combo = getCurrentComboName();
    if (!combo) {
        showToast('请先选择模型和方案', 'warning');
        return;
    }
    exportComboData(combo);
}

function downloadJsonFile(filename, payload) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

function buildRowExportPayload(row) {
    const combo = getCurrentComboName();
    const result = combo && row.results ? (row.results[combo] || null) : null;
    return {
        exported_at: new Date().toISOString(),
        model_strategy: combo,
        row_id: row.id || row._id,
        human_answer: row.human_answer || row.answer || '',
        match_type: row.match_type || '',
        annotation_duration: result ? (result['标注耗时'] || result['标注耗时(ms)'] || '') : '',
        data: row.data || {},
        annotation_result: result
    };
}

function exportRowJson(rowId) {
    const row = state.rows.find(r => String(r.id || r._id) === String(rowId));
    if (!row) {
        showToast('未找到数据', 'error');
        return;
    }
    const combo = getCurrentComboName();
    if (!combo || !row.results || !Object.prototype.hasOwnProperty.call(row.results, combo)) {
        showToast('当前组合暂无标注结果', 'warning');
        return;
    }
    const safeCombo = combo.replace(/[\\/:*?"<>|()\s]+/g, '_').replace(/_+/g, '_');
    const filename = `row_${row.id || row._id}_${safeCombo || 'annotation'}.json`;
    downloadJsonFile(filename, buildRowExportPayload(row));
    showToast('单条 JSON 已导出');
}

async function exportComboData(combo) {
    try {
        if (!combo) {
            showToast('请先选择要导出的组合', 'warning');
            return;
        }
        showToast(`正在导出 ${combo}...`, 'warning');
        const a = document.createElement('a');
        a.href = `/api/export?model=${encodeURIComponent(combo)}&ts=${Date.now()}`;
        a.download = '';
        document.body.appendChild(a);
        a.click();
        a.remove();
        showToast('导出成功');
    } catch (e) {
        showToast('导出失败: ' + e.message, 'error');
    }
}

// ==================== 9. 详情弹窗 ====================
function showDetail(rowId) {
    const row = state.rows.find(r => String(r.id || r._id) === String(rowId));
    if (!row) {
        showToast('未找到数据', 'error');
        return;
    }

    const content = document.getElementById('detailContent');
    let html = '';

    // 基本数据表格
    html += '<div>';
    html += '<h3 class="text-sm font-semibold text-gray-700 mb-2">基本数据</h3>';
    html += '<table class="w-full text-sm border border-gray-200 rounded-lg overflow-hidden">';
    html += '<tbody>';

    // ID
    html += `<tr class="border-b border-gray-100"><td class="px-4 py-2 bg-gray-50 font-medium w-40">ID</td><td class="px-4 py-2">${escapeHtml(row.id || row._id)}</td></tr>`;

    // 人工答案
    html += `<tr class="border-b border-gray-100"><td class="px-4 py-2 bg-gray-50 font-medium">人工答案</td><td class="px-4 py-2">${escapeHtml(row.human_answer || row.answer || '')}</td></tr>`;

    // 匹配类型
    html += `<tr class="border-b border-gray-100"><td class="px-4 py-2 bg-gray-50 font-medium">匹配类型</td><td class="px-4 py-2">${renderMatchBadge(row.match_type || '')}</td></tr>`;

    // data 字段
    if (row.data && typeof row.data === 'object') {
        Object.entries(row.data).forEach(([k, v]) => {
            html += `<tr class="border-b border-gray-100"><td class="px-4 py-2 bg-gray-50 font-medium">${escapeHtml(k)}</td><td class="px-4 py-2 break-all">${escapeHtml(v)}</td></tr>`;
        });
    }

    html += '</tbody></table>';
    html += '</div>';

    // 模型标注结果
    if (row.results && typeof row.results === 'object' && Object.keys(row.results).length > 0) {
        html += '<div>';
        html += '<h3 class="text-sm font-semibold text-gray-700 mb-2">模型标注结果</h3>';

        Object.entries(row.results).forEach(([modelName, result]) => {
            html += `<div class="mb-3">`;
            html += `<div class="text-xs font-semibold text-blue-600 mb-1">${escapeHtml(modelName)}</div>`;
            html += `<pre class="bg-gray-50 border border-gray-200 rounded-lg p-3 text-xs overflow-x-auto">${syntaxHighlightJson(result)}</pre>`;
            html += `</div>`;
        });

        html += '</div>';
    }

    content.innerHTML = html;
    document.getElementById('detailModal').classList.remove('hidden');
}

function closeDetailModal() {
    document.getElementById('detailModal').classList.add('hidden');
}

// ==================== 规则配置模块 ====================
async function loadRuleEditor() {
    try {
        const data = await api('/api/rule');
        state.rule = data || state.rule;
        document.getElementById('ruleEditor').value = JSON.stringify(data, null, 2);
        updateCodePreview('rule');
    } catch (e) {
        console.error('加载规则配置失败', e);
    }
}

async function saveRule() {
    const content = document.getElementById('ruleEditor').value;
    try {
        const parsed = JSON.parse(content);
        await api('/api/rule', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: content
        });
        state.rule = parsed;
        state.dataColumnVisibilityOverrides = {};
        localStorage.removeItem('dataColumnVisibilityOverridesV1');
        renderTable();
        showToast('规则配置保存成功');
    } catch (e) {
        if (e instanceof SyntaxError) {
            showToast('JSON 格式错误，请检查', 'error');
        } else {
            console.error('保存规则配置失败', e);
        }
    }
}

// ==================== 页面切换 ====================
function switchPage(page, btnEl) {
    document.querySelectorAll('.side-menu-item').forEach(btn => btn.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');

    const pageMap = {
        annotation: 'pageAnnotation',
        prompt: 'pagePrompt',
        knowledge: 'pageKnowledge',
        model: 'pageModel',
        rule: 'pageRule',
        stats: 'pageStats'
    };
    Object.values(pageMap).forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden');
    });
    const current = document.getElementById(pageMap[page]);
    if (current) current.classList.remove('hidden');

    if (page === 'rule') {
        loadRuleEditor();
    }
    if (page === 'knowledge') {
        loadKnowledgeList();
    }
    if (page === 'stats') {
        refreshStatsPage();
    }
}
