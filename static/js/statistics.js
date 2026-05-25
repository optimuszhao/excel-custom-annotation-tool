/**
 * 数据飞轮 — 统计数据页面前端逻辑
 * 功能：加载全局标注统计，渲染概览卡片、场景/模型/策略汇总表、最近任务列表
 */

// ========== 全局状态 ==========
let currentSceneFilterId = '';   // 当前场景过滤ID（空字符串=全部）

// ========== 初始化 ==========

document.addEventListener('DOMContentLoaded', async () => {
    // 并行加载场景列表和统计数据
    await Promise.all([
        loadSceneList(),
        loadStatistics(),
    ]);
});

// ========== 加载场景下拉列表 ==========

async function loadSceneList() {
    try {
        const scenes = await apiGet('/api/scenes');
        const sceneFilter = document.getElementById('sceneFilter');
        sceneFilter.innerHTML = '<option value="">全部场景</option>';
        (scenes || []).forEach(scene => {
            const option = document.createElement('option');
            option.value = scene.id;
            option.textContent = scene.name;
            sceneFilter.appendChild(option);
        });
    } catch (error) {
        console.error('加载场景列表失败:', error);
    }
}

// ========== 场景过滤变更 ==========

async function onSceneFilterChange() {
    const sceneFilter = document.getElementById('sceneFilter');
    currentSceneFilterId = sceneFilter.value;
    await loadStatistics();
}

// ========== 加载并渲染统计数据 ==========

async function loadStatistics() {
    try {
        // 构建请求参数：可选场景过滤
        const queryParams = currentSceneFilterId ? `?scene_id=${currentSceneFilterId}` : '';
        const statisticsData = await apiGet(`/api/statistics${queryParams}`);

        // 渲染各区域
        renderOverviewCards(statisticsData.overview || {});
        renderScenesTable(statisticsData.scenes_summary || []);
        renderModelsTable(statisticsData.models_summary || []);
        renderStrategiesTable(statisticsData.strategies_summary || []);
        renderRecentTasksTable(statisticsData.recent_tasks || []);
    } catch (error) {
        console.error('加载统计数据失败:', error);
        showToast('加载统计数据失败', 'error');
    }
}

// ========== 渲染概览卡片 ==========

function renderOverviewCards(overview) {
    document.getElementById('overview-scenes').textContent = overview.total_scenes ?? '-';
    document.getElementById('overview-files').textContent = overview.total_files ?? '-';
    document.getElementById('overview-tasks').textContent = overview.total_tasks ?? '-';

    const avgAccuracyValue = overview.avg_accuracy;
    document.getElementById('overview-accuracy').textContent =
        avgAccuracyValue !== null && avgAccuracyValue !== undefined
            ? formatPercent(avgAccuracyValue)
            : '-';
}

// ========== 渲染场景汇总表 ==========

function renderScenesTable(scenesSummary) {
    const tableBody = document.getElementById('scenesTableBody');
    if (!scenesSummary || scenesSummary.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="5" class="empty-tip">暂无场景数据</td></tr>';
        return;
    }

    tableBody.innerHTML = scenesSummary.map(scene => `
        <tr>
            <td class="font-medium text-gray-800">${escapeHtml(scene.scene_name || '')}</td>
            <td>${scene.total_files ?? 0}</td>
            <td>${scene.total_rows ?? 0}</td>
            <td>${scene.total_tasks ?? 0}</td>
            <td>${renderAccuracyBadge(scene.avg_accuracy)}</td>
        </tr>
    `).join('');
}

// ========== 渲染模型对比表 ==========

function renderModelsTable(modelsSummary) {
    const tableBody = document.getElementById('modelsTableBody');
    if (!modelsSummary || modelsSummary.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="5" class="empty-tip">暂无模型数据</td></tr>';
        return;
    }

    tableBody.innerHTML = modelsSummary.map(modelStats => `
        <tr>
            <td class="font-medium text-gray-800">${escapeHtml(modelStats.model_name || '')}</td>
            <td>${modelStats.task_count ?? 0}</td>
            <td>${renderAccuracyBadge(modelStats.avg_accuracy)}</td>
            <td>${modelStats.avg_recall !== null && modelStats.avg_recall !== undefined
                    ? formatPercent(modelStats.avg_recall)
                    : '<span class="text-gray-400">-</span>'}
            </td>
            <td>${modelStats.avg_f1 !== null && modelStats.avg_f1 !== undefined
                    ? formatPercent(modelStats.avg_f1)
                    : '<span class="text-gray-400">-</span>'}
            </td>
        </tr>
    `).join('');
}

// ========== 渲染策略对比表 ==========

function renderStrategiesTable(strategiesSummary) {
    const tableBody = document.getElementById('strategiesTableBody');
    if (!strategiesSummary || strategiesSummary.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="3" class="empty-tip">暂无策略数据</td></tr>';
        return;
    }

    tableBody.innerHTML = strategiesSummary.map(strategyStats => `
        <tr>
            <td class="font-medium text-gray-800">${escapeHtml(strategyStats.strategy || '')}</td>
            <td>${strategyStats.task_count ?? 0}</td>
            <td>${renderAccuracyBadge(strategyStats.avg_accuracy)}</td>
        </tr>
    `).join('');
}

// ========== 渲染最近任务表 ==========

function renderRecentTasksTable(recentTasks) {
    const tableBody = document.getElementById('recentTableBody');
    if (!recentTasks || recentTasks.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="7" class="empty-tip">暂无已完成任务</td></tr>';
        return;
    }

    tableBody.innerHTML = recentTasks.map(task => {
        // 任务ID截短显示，鼠标悬停显示完整ID
        const shortTaskId = task.id ? task.id.substring(0, 8) + '...' : '-';
        const finishedAt = task.finished_at
            ? new Date(task.finished_at).toLocaleString('zh-CN', { hour12: false })
            : '-';
        return `
            <tr>
                <td>
                    <span title="${escapeHtml(task.id || '')}" class="text-gray-500 font-mono text-xs cursor-default">
                        ${escapeHtml(shortTaskId)}
                    </span>
                </td>
                <td class="font-medium">${escapeHtml(task.model_name || '-')}</td>
                <td>${escapeHtml(task.strategy || '-')}</td>
                <td>${task.success_count ?? task.total_rows ?? 0}</td>
                <td>${renderAccuracyBadge(task.accuracy)}</td>
                <td>${task.f1_score !== null && task.f1_score !== undefined
                        ? formatPercent(task.f1_score)
                        : '<span class="text-gray-400">-</span>'}
                </td>
                <td class="text-gray-500 text-xs">${finishedAt}</td>
            </tr>
        `;
    }).join('');
}

// ========== 工具函数 ==========

/**
 * 将 0~1 之间的小数格式化为百分比字符串（保留1位小数）
 */
function formatPercent(value) {
    if (value === null || value === undefined) return '-';
    return (value * 100).toFixed(1) + '%';
}

/**
 * 根据准确率数值渲染带颜色的标签
 * >= 80% 绿色，>= 60% 黄色，< 60% 红色，null 灰色
 */
function renderAccuracyBadge(accuracyValue) {
    if (accuracyValue === null || accuracyValue === undefined) {
        return '<span class="badge-accuracy none">-</span>';
    }
    const percentText = formatPercent(accuracyValue);
    let colorClass = 'low';
    if (accuracyValue >= 0.8) {
        colorClass = 'high';
    } else if (accuracyValue >= 0.6) {
        colorClass = 'mid';
    }
    return `<span class="badge-accuracy ${colorClass}">${percentText}</span>`;
}

/**
 * HTML 转义，防止 XSS
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}
