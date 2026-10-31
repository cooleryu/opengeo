# AGENTS.md

## 工作方式

- 修复 bug 时，从第一性原理出发，结合成熟实践定位并修复根因，避免只掩盖症状；修复限于当前问题，不扩大为无关重构。
- 调整产品 Agent 时，先从 [按页面找 Agent](skills/README.md) 定位对应页面，再只读当前角色的提示词与参数；应用内参数和提示词由运行入口读取，不另复制一套规则。未接入或未实现的状态以页面导航说明为准。

## 界面设计

Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.

- OpenGEO 新增或修改选择控件时复用 `src/components/geo/GeoSelect.tsx`，不使用会弹出系统配色菜单的原生 `<select>`。视觉检查必须实际展开菜单，覆盖选中、悬停和键盘焦点状态，不能只检查收起状态。
