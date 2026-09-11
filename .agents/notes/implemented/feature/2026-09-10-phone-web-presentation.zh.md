# Agent Note: Web 界面的手机呈现

Status: implemented

[English](2026-09-10-phone-web-presentation.md) | 中文

## 问题

Web 界面是按桌面窗口组合的。在手机浏览器上有三件事让它几乎不可用：框架保留 56px 控制栏加上最小 264px 的侧边栏，打开导航后对话只剩约 110px；可编辑文本为 13–14px，iOS Safari 在聚焦输入框时会把页面放大到输入框并保持放大；被锁屏或标签页挂起冻结的 socket 仍报告为 OPEN，由于浏览器无法观察 Host 的 Ping/Pong 存活检查，对话流会停止，直到手动刷新。第四种故障对长 Session 影响最大：历史页仅按消息条数设限，因此工具结果远超消息的 Session 会作为单个数兆字节的帧打开；由于该帧排在同一 follow 的 Assistant 帧之前写出，读者在它写完之前既看不到历史也看不到流式内容。

## 决定

低于 768px 时布局框架进入手机模式。左侧网格轨道为零，框架在中栏左上角绘制自己的"打开侧边栏"控件并发布 `--dsh-frame-leading-inset` 供对话标题行避让，侧边栏占用方只在覆盖中栏的 300px 抽屉内渲染，抽屉后有遮罩。点按遮罩或选中某个 Session 或全局面板时抽屉关闭；选中订阅者是独立组件，因此栏框架不会因这些变化而重新渲染。768px 与 ui-sidebar-right 推导全屏所用的数值相同，因此两栏在同一宽度切换呈现（[ui-layout](../../../../packages/client/ui-layout/README.zh.md)）。

Gateway 在每次 Ping 旁发送一个 `heartbeat` 文本帧。浏览器流客户端会放弃一个报告为 OPEN 但连续三个间隔没有收到心跳的 socket，并在文档重新可见的瞬间复查该截止时间，因为挂起的页面同样会冻结计时器。被放弃的 socket 以载体错误使其逻辑流失败，于是现有的 Connection 重试和 Session follow 的重连基线（已携带进行中的 assistant 尝试）无需刷新即可恢复对话（[gateway](../../../../packages/api/gateway/README.zh.md)）。

历史页增加第二重上限：页面各事件序列化后约一百万个字符，在与条数上限相同的消息边界处检查，并通过既有的 `hasMore` 上报，而读者本来就据此向前翻页。最新的那条消息仍然连同整组一起发出，无论多大，因为读者读不到的页面比一个长帧更糟（[session-controller](../../../../packages/api/session-controller/README.zh.md)）。

触控优先的浏览器从 shell 基础样式表获得所有可编辑控件的 16px 下限，以 `(pointer: coarse)` 为条件，使桌面组合保留 13–14px 的控件；主题呈现器在同一查询下把内容字号轴发布为 `max(16px, 偏好)`，使对话文字按手机尺寸重排，而不是依赖浏览器只放大不重排、会裁切页面的聚焦缩放；静态服务器对哈希资源目录之外的所有响应发送 `Cache-Control: no-cache`，使手机在重新构建后重新校验；作曲器的附件与发送圆形按钮、消息操作条、侧边栏图标控件、模型与权限触发器以及右侧栏展开控件在同一查询下向 44px 指引增大。宽 Markdown 表格在没有悬停时保持可平移，填充表格在手机栏中可以断开长单元格，页面声明 `viewport-fit=cover`，作曲器为底部安全区留出内边距，portal 出去的模型、谱系与原语菜单按动态视口计算尺寸。问题作曲器在低于 720px 时页脚换行，使「跳过」与「提交」留在卡片内而不是越过右边缘（这正是竖屏下它们被隐藏的原因），Settings 对话框在低于 768px 时铺满屏幕，分区轨道变为内容上方可横向滚动的一行（[ui-user-questions](../../../../packages/client/ui-user-questions/README.zh.md)、[ui-settings-general](../../../../packages/client/ui-settings-general/README.zh.md)）。

## 考虑过的替代方案

通过 `maximum-scale` 禁用捏合缩放也能阻止聚焦缩放，但会剥夺读者的无障碍控制；16px 下限改为消除触发条件。服务器端按 Session 的重放缓冲可以让 Host 重发挂起期间丢失的帧，但 follow 的开场基线已经重新交付进行中的尝试，所以缺失的只是检测死 socket。把手机打开控件放进对话标题行需要新的 root 作用域 slot，而且 hero 页面没有标题行；框架拥有栏几何，由它自己绘制控件。在手机上保留更窄的控制栏被否决，因为控制栏唯一的功能是打开侧边栏，一个角落控件就能提供且不占栏宽。

## 后果

框架多拥有一种呈现模式和一个标题行内边距变量，绘制前导控件的栏占用方必须遵守它。每个 Client 每个心跳间隔都会收到一个小文本帧；调大 `websocketHeartbeatIntervalMs` 的部署也会延长挂起 socket 被察觉的时间，README 已说明。桌面呈现不变。无密钥的手机 e2e（[mobile-viewport](../../../../apps/web/tests/mobile-viewport.e2e.ts)）把 390px 下的框架几何、抽屉行为、待答问题控件、标题菜单位置、Settings 表单、作曲器字号下限和表格可平移性记录为 golden；仍然挤占 390px 标题行的标题操作和轨迹表的固定列仍是桌面形态，是自然的下一步。
