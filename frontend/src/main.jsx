import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  App as AntApp,
  Button,
  Card,
  Checkbox,
  Col,
  Drawer,
  Dropdown,
  Form,
  Input,
  InputNumber,
  Layout,
  Menu,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  Tree,
  Upload,
  message,
} from 'antd';
import {
  BarChartOutlined,
  BookOutlined,
  BranchesOutlined,
  CloudUploadOutlined,
  DatabaseOutlined,
  FileTextOutlined,
  MessageOutlined,
  MoreOutlined,
  RobotOutlined,
  SettingOutlined,
  TagsOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import './styles.css';

const { Header, Sider, Content } = Layout;
const apiBase = '';

async function api(path, options = {}) {
  const resp = await fetch(`${apiBase}${path}`, options);
  const text = await resp.text();
  const data = text ? JSON.parse(text) : {};
  if (!resp.ok) {
    throw new Error(data.detail || text || `HTTP ${resp.status}`);
  }
  return data;
}

function toTree(items, parentId = null) {
  return items
    .filter((item) => (item.parent_id || null) === parentId)
    .map((item) => ({
      title: item.name,
      key: item.id,
      value: item.id,
      children: toTree(items, item.id),
    }));
}

function percent(value) {
  return `${((Number(value) || 0) * 100).toFixed(1)}%`;
}

function useBootstrap() {
  const [state, setState] = useState({
    scenes: [],
    sceneId: null,
    excels: [],
    models: [],
    prompts: [],
    roles: [],
    knowledge: [],
    fewshots: [],
    rules: [],
    stats: {},
  });

  async function reload(partial = {}) {
    const scenesData = partial.scenes || (await api('/api/scenes')).items;
    const sceneId = partial.sceneId || state.sceneId || scenesData[0]?.id || null;
    const [excels, models, prompts, roles, knowledge, fewshots, rules, stats] = await Promise.all([
      sceneId ? api(`/api/excels?scene_id=${sceneId}`) : { items: [] },
      api('/api/models'),
      sceneId ? api(`/api/prompts?scene_id=${sceneId}`) : { items: [] },
      sceneId ? api(`/api/roles?scene_id=${sceneId}`) : { items: [] },
      sceneId ? api(`/api/knowledge?scene_id=${sceneId}`) : { items: [] },
      sceneId ? api(`/api/fewshots?scene_id=${sceneId}`) : { items: [] },
      sceneId ? api(`/api/rules?scene_id=${sceneId}`) : { items: [] },
      sceneId ? api(`/api/stats?scene_id=${sceneId}`) : {},
    ]);
    setState({
      scenes: scenesData,
      sceneId,
      excels: excels.items || [],
      models: models.items || [],
      prompts: prompts.items || [],
      roles: roles.items || [],
      knowledge: knowledge.items || [],
      fewshots: fewshots.items || [],
      rules: rules.items || [],
      stats,
    });
  }

  useEffect(() => {
    reload().catch((err) => message.error(err.message));
  }, []);

  return [state, reload, setState];
}

function SceneSelector({ state, reload }) {
  const treeData = useMemo(() => toTree(state.scenes), [state.scenes]);
  return (
    <Select
      className="top-select"
      value={state.sceneId}
      options={state.scenes.map((scene) => ({ value: scene.id, label: scene.path }))}
      onChange={(sceneId) => reload({ sceneId })}
      placeholder="选择场景"
      showSearch
      optionFilterProp="label"
      dropdownRender={(menu) => (
        <div>
          {menu}
          <div className="scene-tree-mini">
            <Tree treeData={treeData} defaultExpandAll selectable={false} />
          </div>
        </div>
      )}
    />
  );
}

function ScenePage({ state, reload }) {
  const [form] = Form.useForm();
  const [editing, setEditing] = useState(null);
  const treeData = useMemo(() => toTree(state.scenes), [state.scenes]);

  async function submit(values) {
    if (editing) {
      await api(`/api/scenes/${editing.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
    } else {
      await api('/api/scenes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
    }
    form.resetFields();
    setEditing(null);
    await reload();
  }

  return (
    <Row gutter={16}>
      <Col span={10}>
        <Card title="场景树">
          <Tree treeData={treeData} defaultExpandAll />
        </Card>
      </Col>
      <Col span={14}>
        <Card title={editing ? '编辑场景' : '新增场景'}>
          <Form form={form} layout="vertical" onFinish={submit}>
            <Form.Item name="name" label="场景名称" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
            <Form.Item name="parent_id" label="父级场景">
              <Select
                allowClear
                options={state.scenes.map((scene) => ({ value: scene.id, label: scene.path }))}
              />
            </Form.Item>
            <Space>
              <Button type="primary" htmlType="submit">保存</Button>
              <Button onClick={() => { setEditing(null); form.resetFields(); }}>清空</Button>
            </Space>
          </Form>
        </Card>
        <Card title="场景列表" className="mt16">
          <Table
            rowKey="id"
            dataSource={state.scenes}
            pagination={false}
            columns={[
              { title: 'ID', dataIndex: 'id', width: 80 },
              { title: '路径', dataIndex: 'path' },
              {
                title: '操作',
                width: 180,
                render: (_, record) => (
                  <Space>
                    <Button size="small" onClick={() => { setEditing(record); form.setFieldsValue(record); }}>编辑</Button>
                    <Popconfirm title="删除场景？" onConfirm={async () => { await api(`/api/scenes/${record.id}`, { method: 'DELETE' }); await reload(); }}>
                      <Button danger size="small">删除</Button>
                    </Popconfirm>
                  </Space>
                ),
              },
            ]}
          />
        </Card>
      </Col>
    </Row>
  );
}

function ExcelPage({ state, reload }) {
  const [displayName, setDisplayName] = useState('');
  const uploadProps = {
    customRequest: async ({ file, onSuccess, onError }) => {
      try {
        const formData = new FormData();
        formData.append('file', file);
        await api(`/api/excels/upload?scene_id=${state.sceneId}&display_name=${encodeURIComponent(displayName || file.name)}`, {
          method: 'POST',
          body: formData,
        });
        message.success('上传成功');
        onSuccess();
        setDisplayName('');
        await reload();
      } catch (err) {
        message.error(err.message);
        onError(err);
      }
    },
    showUploadList: false,
  };

  return (
    <Card title="Excel 管理" extra={<SceneSelector state={state} reload={reload} />}>
      <Space className="mb16">
        <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Excel 显示名称" />
        <Upload {...uploadProps}>
          <Button icon={<UploadOutlined />}>上传 Excel</Button>
        </Upload>
      </Space>
      <Table
        rowKey="id"
        dataSource={state.excels}
        columns={[
          { title: 'ID', dataIndex: 'id', width: 80 },
          { title: '名称', dataIndex: 'display_name' },
          { title: '源文件', dataIndex: 'original_file_name' },
          { title: '行数', dataIndex: 'row_count', width: 100 },
          { title: '标注数', dataIndex: 'annotation_count', width: 100 },
          { title: '列', render: (_, r) => (r.columns || []).join('、'), ellipsis: true },
          {
            title: '操作',
            width: 120,
            render: (_, record) => (
              <Popconfirm title="删除 Excel 及关联数据？" onConfirm={async () => { await api(`/api/excels/${record.id}`, { method: 'DELETE' }); await reload(); }}>
                <Button danger size="small">删除</Button>
              </Popconfirm>
            ),
          },
        ]}
      />
    </Card>
  );
}

function AssetPage({ title, state, reload, endpoint, fields, fileField = true }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form] = Form.useForm();
  const items = state[endpoint] || [];

  async function save(values) {
    const payload = { ...values, scene_id: state.sceneId };
    const url = editing ? `/api/${endpoint}/${editing.id}` : `/api/${endpoint}`;
    await api(url, {
      method: editing ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    setOpen(false);
    setEditing(null);
    form.resetFields();
    await reload();
  }

  return (
    <Card title={title} extra={<Space><SceneSelector state={state} reload={reload} /><Button type="primary" onClick={() => setOpen(true)}>新增</Button></Space>}>
      <Table
        rowKey="id"
        dataSource={items}
        columns={[
          { title: 'ID', dataIndex: 'id', width: 70 },
          { title: '名称', dataIndex: 'name', width: 180 },
          ...fields.map((field) => ({ title: field.label, dataIndex: field.name, ellipsis: true })),
          { title: '启用', dataIndex: 'enabled', width: 90, render: (v) => <Tag color={v ? 'green' : 'default'}>{v ? '启用' : '停用'}</Tag> },
          {
            title: '操作',
            width: 160,
            render: (_, record) => (
              <Space>
                <Button size="small" onClick={() => { setEditing(record); form.setFieldsValue(record); setOpen(true); }}>编辑</Button>
                <Popconfirm title="确认删除？" onConfirm={async () => { await api(`/api/${endpoint}/${record.id}`, { method: 'DELETE' }); await reload(); }}>
                  <Button danger size="small">删除</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <Modal title={editing ? `编辑${title}` : `新增${title}`} open={open} onCancel={() => { setOpen(false); setEditing(null); form.resetFields(); }} onOk={() => form.submit()} width={820}>
        <Form form={form} layout="vertical" onFinish={save} initialValues={{ enabled: true }}>
          <Form.Item name="name" label="名称" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          {fileField && (
            <Form.Item name="file_name" label="文件名">
              <Input />
            </Form.Item>
          )}
          {fields.map((field) => (
            <Form.Item key={field.name} name={field.name} label={field.label} rules={field.required ? [{ required: true }] : []}>
              {field.type === 'select' ? <Select options={field.options || []} /> : field.type === 'textarea' ? <Input.TextArea rows={12} /> : <Input />}
            </Form.Item>
          ))}
          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}

function AnnotationPage({ state, reload }) {
  const [excelId, setExcelId] = useState(null);
  const [modelId, setModelId] = useState(null);
  const [roleIds, setRoleIds] = useState([]);
  const [rows, setRows] = useState([]);
  const [columns, setColumns] = useState([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState([]);
  const [filters, setFilters] = useState({});
  const [detail, setDetail] = useState(null);
  const [page, setPage] = useState(1);

  const currentExcel = state.excels.find((item) => item.id === excelId) || state.excels[0];
  const activeExcelId = excelId || currentExcel?.id;
  const activeModelId = modelId || state.models[0]?.id;

  async function loadRows(nextPage = page, nextFilters = filters) {
    if (!activeExcelId) {
      setRows([]);
      setColumns([]);
      setTotal(0);
      return;
    }
    const data = await api(`/api/excels/${activeExcelId}/rows?page=${nextPage}&page_size=20&filters=${encodeURIComponent(JSON.stringify(nextFilters))}`);
    setRows(data.items);
    setColumns(data.columns);
    setTotal(data.total);
    setPage(nextPage);
  }

  useEffect(() => {
    if (activeExcelId) loadRows(1).catch((err) => message.error(err.message));
  }, [activeExcelId]);

  async function annotate(rowIds) {
    if (!activeExcelId || !activeModelId || roleIds.length === 0) {
      message.warning('请选择 Excel、模型和角色');
      return;
    }
    await api('/api/annotations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scene_id: state.sceneId,
        excel_file_id: activeExcelId,
        row_ids: rowIds,
        model_config_id: activeModelId,
        role_ids: roleIds,
        concurrency: 1,
      }),
    });
    message.success('标注任务已提交');
    setTimeout(() => {
      loadRows().catch(() => {});
      reload().catch(() => {});
    }, 1600);
  }

  async function clearSelectedAnnotations() {
    if (!selected.length) {
      message.warning('请选择数据');
      return;
    }
    await api('/api/annotations', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scene_id: state.sceneId,
        excel_file_id: activeExcelId,
        row_ids: selected,
      }),
    });
    message.success('已清空选中标注');
    setSelected([]);
    await loadRows();
    await reload();
  }

  async function deleteSelectedRows() {
    if (!selected.length) {
      message.warning('请选择数据');
      return;
    }
    await api('/api/rows', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scene_id: state.sceneId,
        excel_file_id: activeExcelId,
        row_ids: selected,
      }),
    });
    message.success('已删除选中数据');
    setSelected([]);
    await loadRows(1);
    await reload();
  }

  async function cancelPendingTasks() {
    if (!activeExcelId) return;
    const data = await api('/api/annotations/tasks/cancel-pending', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scene_id: state.sceneId,
        excel_file_id: activeExcelId,
      }),
    });
    message.success(`已取消 ${data.cancelled || 0} 个排队任务`);
    await reload();
  }

  function applyColumnFilter(key, value) {
    const next = { ...filters, [key]: value };
    setFilters(next);
    loadRows(1, next).catch((err) => message.error(err.message));
  }

  const tableColumns = [
    {
      title: 'ID',
      dataIndex: 'id',
      width: 80,
      filterDropdown: () => <Input.Search placeholder="筛选 ID" onSearch={(v) => applyColumnFilter('id', v)} allowClear />,
    },
    {
      title: '人工答案',
      dataIndex: 'human_answer',
      width: 110,
      filterDropdown: () => <Input.Search placeholder="筛选人工答案" onSearch={(v) => applyColumnFilter('human_answer', v)} allowClear />,
    },
    {
      title: '最终答案',
      width: 110,
      render: (_, r) => r.annotation?.final_label || '-',
      filters: [{ text: '是', value: '是' }, { text: '否', value: '否' }],
      onFilter: () => true,
      filterDropdown: () => <Select allowClear className="filter-select" options={[{ value: '是' }, { value: '否' }]} onChange={(v) => applyColumnFilter('final_label', v)} />,
    },
    {
      title: '匹配类型',
      width: 110,
      render: (_, r) => <Tag>{r.annotation?.match_type || '未标注'}</Tag>,
      filterDropdown: () => <Select allowClear className="filter-select" options={['TP', 'FN', 'FP', 'TN', 'UNKNOWN'].map((value) => ({ value }))} onChange={(v) => applyColumnFilter('match_type', v)} />,
    },
    ...columns.map((name) => ({
      title: name,
      ellipsis: true,
      render: (_, r) => String(r.data?.[name] ?? ''),
      filterDropdown: () => <Input.Search placeholder={`筛选 ${name}`} onSearch={(v) => applyColumnFilter(`data.${name}`, v)} allowClear />,
    })),
    {
      title: '操作',
      fixed: 'right',
      width: 180,
      render: (_, record) => (
        <Space>
          <Button size="small" type="primary" onClick={() => annotate([record.id])}>标注</Button>
          <Button size="small" onClick={() => setDetail(record)}>详情</Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Card className="mb16">
        <Space wrap>
          <SceneSelector state={state} reload={reload} />
          <Select className="top-select" placeholder="Excel" value={activeExcelId} options={state.excels.map((item) => ({ value: item.id, label: item.display_name }))} onChange={(v) => { setExcelId(v); setSelected([]); }} />
          <Select className="top-select" placeholder="模型" value={activeModelId} options={state.models.map((item) => ({ value: item.id, label: item.name }))} onChange={setModelId} />
          <Select mode="multiple" className="role-select" placeholder="标注角色" value={roleIds} options={state.roles.map((item) => ({ value: item.id, label: item.name }))} onChange={setRoleIds} />
          <Button type="primary" disabled={!selected.length} onClick={() => annotate(selected)}>标注选中</Button>
          <Button disabled={!rows.length} onClick={() => annotate(rows.map((row) => row.id))}>标注当前页</Button>
          <Popconfirm title="清空选中数据的标注结果？" disabled={!selected.length} onConfirm={clearSelectedAnnotations}>
            <Button disabled={!selected.length}>清空标注</Button>
          </Popconfirm>
          <Popconfirm title="删除选中数据及关联任务结果？" disabled={!selected.length} onConfirm={deleteSelectedRows}>
            <Button danger disabled={!selected.length}>删除选中</Button>
          </Popconfirm>
          <Button disabled={!activeExcelId} onClick={() => window.open(`/api/export?scene_id=${state.sceneId}&excel_file_id=${activeExcelId}`)}>导出</Button>
          <Dropdown
            menu={{
              items: [
                { key: 'cancel', label: '取消排队任务' },
                { key: 'clearSelection', label: '取消选择' },
                { key: 'refresh', label: '刷新数据' },
              ],
              onClick: ({ key }) => {
                if (key === 'cancel') cancelPendingTasks();
                if (key === 'clearSelection') setSelected([]);
                if (key === 'refresh') loadRows(1, {});
              },
            }}
          >
            <Button icon={<MoreOutlined />}>更多</Button>
          </Dropdown>
        </Space>
      </Card>
      <StatsCards stats={state.stats} />
      <Card className="mt16">
        <Table
          rowKey="id"
          dataSource={rows}
          columns={tableColumns}
          scroll={{ x: 1400 }}
          rowSelection={{ selectedRowKeys: selected, onChange: setSelected }}
          pagination={{ current: page, pageSize: 20, total, onChange: (p) => loadRows(p) }}
        />
      </Card>
      <Modal title="数据详情" open={!!detail} onCancel={() => setDetail(null)} footer={null} width={900}>
        <pre className="json-box">{JSON.stringify(detail, null, 2)}</pre>
      </Modal>
    </div>
  );
}

function StatsCards({ stats }) {
  return (
    <Row gutter={16}>
      <Col span={4}><Card><Statistic title="总量" value={stats.total || 0} /></Card></Col>
      <Col span={4}><Card><Statistic title="已标注" value={stats.annotated || 0} /></Card></Col>
      <Col span={4}><Card><Statistic title="UNKNOWN" value={stats.unknown || 0} /></Card></Col>
      <Col span={4}><Card><Statistic title="准确率" value={percent(stats.accuracy)} /></Card></Col>
      <Col span={4}><Card><Statistic title="F1" value={percent(stats.f1_score)} /></Card></Col>
      <Col span={4}><Card><Statistic title="TP/FN/FP/TN" value={`${stats.tp || 0}/${stats.fn || 0}/${stats.fp || 0}/${stats.tn || 0}`} /></Card></Col>
    </Row>
  );
}

function ChatDrawer({ open, onClose, state }) {
  const [messageText, setMessageText] = useState('');
  const [reply, setReply] = useState('');
  async function send() {
    const data = await api('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scene_id: state.sceneId, message: messageText }),
    });
    setReply(data.reply);
  }
  return (
    <Drawer title="大模型对话 Mock" open={open} onClose={onClose} width={520}>
      <Input.TextArea rows={8} value={messageText} onChange={(e) => setMessageText(e.target.value)} placeholder="输入要测试的 Prompt、规则或问题" />
      <Button type="primary" className="mt16" onClick={send}>发送</Button>
      <pre className="chat-reply">{reply}</pre>
    </Drawer>
  );
}

function AppShell() {
  const [state, reload] = useBootstrap();
  const [page, setPage] = useState('annotation');
  const [chatOpen, setChatOpen] = useState(false);

  const promptOptions = state.prompts.map((item) => ({ value: item.id, label: item.name }));
  const pages = {
    annotation: <AnnotationPage state={state} reload={reload} />,
    excels: <ExcelPage state={state} reload={reload} />,
    scenes: <ScenePage state={state} reload={reload} />,
    prompts: <AssetPage title="Prompt 管理" endpoint="prompts" state={state} reload={reload} fields={[{ name: 'content', label: '内容', type: 'textarea', required: true }]} />,
    roles: <AssetPage title="标注角色" endpoint="roles" state={state} reload={reload} fileField={false} fields={[{ name: 'prompt_id', label: '绑定 Prompt', type: 'select', options: promptOptions, required: true }, { name: 'sort_order', label: '排序' }]} />,
    knowledge: <AssetPage title="知识管理" endpoint="knowledge" state={state} reload={reload} fields={[{ name: 'content', label: '内容', type: 'textarea' }]} />,
    fewshots: <AssetPage title="错题本管理" endpoint="fewshots" state={state} reload={reload} fileField={false} fields={[{ name: 'cot_name', label: 'CoT 名称', required: true }, { name: 'content', label: 'Few-shots 内容', type: 'textarea' }]} />,
    rules: <AssetPage title="规则管理" endpoint="rules" state={state} reload={reload} fields={[{ name: 'content', label: 'JSON 内容', type: 'textarea', required: true }]} />,
    models: <AssetPage title="模型配置" endpoint="models" state={state} reload={reload} fields={[{ name: 'content', label: 'YAML 内容', type: 'textarea', required: true }]} />,
    stats: <Card title="统计数据"><StatsCards stats={state.stats} /></Card>,
  };

  return (
    <AntApp>
      <Layout className="shell">
        <Sider width={220} theme="light">
          <div className="brand"><DatabaseOutlined /> 数据飞轮</div>
          <Menu
            selectedKeys={[page]}
            onClick={(item) => setPage(item.key)}
            items={[
              { key: 'annotation', icon: <RobotOutlined />, label: '数据标注' },
              { key: 'excels', icon: <CloudUploadOutlined />, label: 'Excel 管理' },
              { key: 'scenes', icon: <BranchesOutlined />, label: '场景管理' },
              { key: 'prompts', icon: <FileTextOutlined />, label: 'Prompt 管理' },
              { key: 'roles', icon: <TagsOutlined />, label: '标注角色' },
              { key: 'knowledge', icon: <BookOutlined />, label: '知识管理' },
              { key: 'fewshots', icon: <BookOutlined />, label: '错题本管理' },
              { key: 'rules', icon: <SettingOutlined />, label: '规则管理' },
              { key: 'models', icon: <SettingOutlined />, label: '模型配置' },
              { key: 'stats', icon: <BarChartOutlined />, label: '统计数据' },
            ]}
          />
        </Sider>
        <Layout>
          <Header className="topbar">
            <SceneSelector state={state} reload={reload} />
            <Button icon={<MessageOutlined />} onClick={() => setChatOpen(true)}>大模型对话</Button>
          </Header>
          <Content className="content">{pages[page]}</Content>
        </Layout>
        <ChatDrawer open={chatOpen} onClose={() => setChatOpen(false)} state={state} />
      </Layout>
    </AntApp>
  );
}

createRoot(document.getElementById('root')).render(<AppShell />);
