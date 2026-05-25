/**
 * 数据飞轮 - 可复用 UI 组件
 * 场景选择器、分页器、搜索框、详情面板等
 */

// ========== 场景选择器组件 ==========

class SceneSelector {
    constructor(containerId, options = {}) {
        this.container = document.getElementById(containerId);
        this.onChange = options.onChange || (() => {});
        this.scenes = [];
        this.currentSceneId = null;
        this.showAddButton = options.showAddButton !== false;
    }

    async load() {
        this.scenes = await apiGet('/api/scenes');
        this.render();
        // 默认选中第一个或URL参数中的场景
        const urlSceneId = getUrlParam('scene_id');
        if (urlSceneId && this.scenes.find(s => s.id == urlSceneId)) {
            this.select(parseInt(urlSceneId));
        } else if (this.scenes.length > 0) {
            this.select(this.scenes[0].id);
        }
    }

    render() {
        if (!this.container) return;
        let html = '<div class="scene-selector">';
        html += '<div class="scene-selector__list">';
        this.scenes.forEach(scene => {
            const isActive = scene.id === this.currentSceneId;
            html += `<div class="scene-selector__item ${isActive ? 'scene-selector__item--active' : ''}" data-scene-id="${scene.id}">${scene.name}</div>`;
        });
        if (this.showAddButton) {
            html += '<div class="scene-selector__add" id="scene-add-btn">+ 新增场景</div>';
        }
        html += '</div></div>';
        this.container.innerHTML = html;
        this.bindEvents();
    }

    bindEvents() {
        this.container.querySelectorAll('.scene-selector__item').forEach(item => {
            item.addEventListener('click', () => this.select(parseInt(item.dataset.sceneId)));
        });
        const addBtn = this.container.querySelector('#scene-add-btn');
        if (addBtn) {
            addBtn.addEventListener('click', () => this.handleAdd());
        }
    }

    select(sceneId) {
        this.currentSceneId = sceneId;
        setUrlParam('scene_id', sceneId);
        this.render();
        this.onChange(sceneId);
    }

    async handleAdd() {
        const name = prompt('请输入新场景名称：');
        if (!name || !name.trim()) return;
        try {
            const newScene = await apiPost('/api/scenes', { name: name.trim() });
            this.scenes.push(newScene);
            this.select(newScene.id);
            showToast('场景创建成功', 'success');
        } catch (e) {}
    }

    getCurrentSceneId() { return this.currentSceneId; }
}

// ========== 分页器组件 ==========

class Pagination {
    constructor(containerId, options = {}) {
        this.container = document.getElementById(containerId);
        this.pageSize = options.pageSize || 20;
        this.currentPage = 1;
        this.total = 0;
        this.onChange = options.onChange || (() => {});
    }

    update(total, currentPage) {
        this.total = total;
        this.currentPage = currentPage;
        this.render();
    }

    get totalPages() { return Math.ceil(this.total / this.pageSize); }

    render() {
        if (!this.container) return;
        const totalPages = this.totalPages;
        if (totalPages <= 1) { this.container.innerHTML = ''; return; }
        
        let html = '<div class="pagination">';
        html += `<button class="pagination__btn" ${this.currentPage <= 1 ? 'disabled' : ''} data-page="${this.currentPage - 1}">上一页</button>`;
        
        // 页码按钮（最多显示7个）
        const pages = this.getPageNumbers(totalPages);
        pages.forEach(p => {
            if (p === '...') {
                html += '<span class="pagination__ellipsis">...</span>';
            } else {
                html += `<button class="pagination__btn ${p === this.currentPage ? 'pagination__btn--active' : ''}" data-page="${p}">${p}</button>`;
            }
        });
        
        html += `<button class="pagination__btn" ${this.currentPage >= totalPages ? 'disabled' : ''} data-page="${this.currentPage + 1}">下一页</button>`;
        html += `<span class="pagination__info">共 ${this.total} 条</span>`;
        html += '</div>';
        this.container.innerHTML = html;
        
        this.container.querySelectorAll('.pagination__btn:not([disabled])').forEach(btn => {
            btn.addEventListener('click', () => {
                const page = parseInt(btn.dataset.page);
                if (page >= 1 && page <= totalPages) {
                    this.currentPage = page;
                    this.onChange(page);
                }
            });
        });
    }

    getPageNumbers(total) {
        if (total <= 7) return Array.from({length: total}, (_, i) => i + 1);
        const current = this.currentPage;
        const pages = [];
        pages.push(1);
        if (current > 3) pages.push('...');
        for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) {
            pages.push(i);
        }
        if (current < total - 2) pages.push('...');
        pages.push(total);
        return pages;
    }
}

// ========== 详情面板组件 ==========

class DetailPanel {
    constructor() {
        this.panel = null;
        this.init();
    }

    init() {
        const panel = document.createElement('div');
        panel.id = 'detail-panel';
        panel.className = 'detail-panel';
        panel.style.display = 'none';
        panel.innerHTML = `
            <div class="detail-panel__overlay" id="detail-overlay"></div>
            <div class="detail-panel__content">
                <div id="detail-resize-handle" style="position:absolute; left:0; top:0; bottom:0; width:6px; cursor:col-resize; background:transparent; z-index:10;"></div>
                <div class="detail-panel__header">
                    <h3 id="detail-title" class="text-lg font-semibold"></h3>
                    <button id="detail-close-btn" class="text-gray-500 hover:text-gray-700">&times;</button>
                </div>
                <div id="detail-body" class="detail-panel__body"></div>
            </div>
        `;
        document.body.appendChild(panel);
        this.panel = panel;
        
        document.getElementById('detail-close-btn').addEventListener('click', () => this.hide());
        document.getElementById('detail-overlay').addEventListener('click', () => this.hide());

        // 拖拽调整宽度
        const handle = document.getElementById('detail-resize-handle');
        const content = panel.querySelector('.detail-panel__content');
        let startX, startWidth;

        handle.addEventListener('mousedown', (e) => {
            startX = e.clientX;
            startWidth = content.offsetWidth;
            document.addEventListener('mousemove', onDrag);
            document.addEventListener('mouseup', stopDrag);
            e.preventDefault();
        });

        function onDrag(e) {
            const diff = startX - e.clientX;
            const newWidth = Math.max(400, Math.min(window.innerWidth * 0.95, startWidth + diff));
            content.style.width = newWidth + 'px';
        }

        function stopDrag() {
            document.removeEventListener('mousemove', onDrag);
            document.removeEventListener('mouseup', stopDrag);
        }
    }

    show(title, content) {
        document.getElementById('detail-title').textContent = title;
        document.getElementById('detail-body').innerHTML = content;
        this.panel.style.display = 'flex';
    }

    hide() {
        this.panel.style.display = 'none';
    }
}

// 全局详情面板实例
let detailPanel = null;
function getDetailPanel() {
    if (!detailPanel) detailPanel = new DetailPanel();
    return detailPanel;
}
