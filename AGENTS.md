# AGENTS.md

## 工作方式

- 修复 bug 时，从第一性原理出发，结合成熟实践定位并修复根因，避免只掩盖症状；修复限于当前问题，不扩大为无关重构。
- 调整产品 Agent 时，先从 [按页面找 Agent](skills/README.md) 定位对应页面，再只读当前角色的提示词与参数；应用内参数和提示词由运行入口读取，不另复制一套规则。未接入或未实现的状态以页面导航说明为准。

## 仓库与本地资料

- 本目录是唯一日常开发目录，`origin` 为 `cooleryu/opengeo`。`main` 对应已公开版本，未完成内容在开发分支；不再维护单独的公开副本或手工复制发布。
- 密钥、数据库、真实项目材料和历史导入映射只保存在被 Git 忽略的本地目录。项目材料由 `data/local-projects/projects.json` 加载；没有本地配置时使用公开空示例。测试使用合成资料，不依赖个人项目。

## 界面设计

Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.

- OpenGEO 新增或修改选择控件时复用 `src/components/geo/GeoSelect.tsx`，不使用会弹出系统配色菜单的原生 `<select>`。视觉检查必须实际展开菜单，覆盖选中、悬停和键盘焦点状态，不能只检查收起状态。
