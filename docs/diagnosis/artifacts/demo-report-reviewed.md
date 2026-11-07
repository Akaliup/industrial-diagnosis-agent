# 设备诊断报告 run_f3659b0520144e8d8ada

- 设备：1号循环泵（NP-200 / NP200-2023-001）
- 数据模式：mock
- 模型模式：fixture
- 结论状态：engineer_confirmed
- 人工复核：accepted
- 生成时间：2026-11-07T05:45:41.950Z

## 报警

- DEMO-BRG-01 / high：轴承温度高

## 观察

- 报警 DEMO-BRG-01（high，active）：轴承温度高。
- 设备 EQ-DEMO-001 状态 alarm，最后上报 2026-11-07T00:30:00.000Z。
- bearing_temperature 从 61.88°C 变化到 77.29°C（Δ15.41），缺失 0 点。
- vibration_rms 从 2.18mm/s 变化到 2.18mm/s（Δ0.00），缺失 0 点。
- motor_current 从 48.13A 变化到 47.92A（Δ-0.21），缺失 0 点。
- discharge_pressure 从 0.62MPa 变化到 0.63MPa（Δ0.01），缺失 0 点。
- flow_rate 从 119.28m3/h 变化到 120.45m3/h（Δ1.17），缺失 0 点。
- 手册 DOC-NP200-V2-ZH NP-200 v2 第 3 页：## 5.3 温度传感器漂移检查
若轴承温度上升而振动有效值和电机电流保持稳定，应使用手持测温仪对比。偏差超过 5 °C 表明传感器漂移，应更换传感器。。
- 手册 DOC-NP200-V2-ZH NP-200 v2 第 2 页：## 5.2 轴承温度监测
报警阈值为 80 °C。应观察 30 分钟趋势，单点尖峰不足以判定机械故障。。
- 手册 DOC-NP200-V2-ZH NP-200 v2 第 4 页：## 6.1 振动限值
振动有效值超过 4.5 mm/s 表明机械状态异常。振动上升并伴随电机电流上升提示轴承磨损，应结合油液分析与振动频谱确认。。
- 手册 DOC-NP200-V2-ZH NP-200 v2 第 5 页：## 7.1 通讯与采样故障
采样缺失、时间戳乱序，或通讯报警已恢复且工艺值正常，表明数据链路故障，不应据此更换机械部件。。
- 手册 DOC-NP200-V2 NP-200 v2 第 3 页：5.3 Temperature sensor drift check. If bearing temperature rises while vibration RMS and
motor current remain stable, co。
- 手册 DOC-NP200-V2 NP-200 v2 第 2 页：5.2 Bearing temperature monitoring. The bearing temperature alarm threshold is 80 C. Use
the 30-minute trend; a single s。
- 手册 DOC-NP200-V2 NP-200 v2 第 4 页：6.1 Vibration limits. RMS above 4.5 mm/s indicates an abnormal mechanical condition. A
rising trend with increased motor。
- 手册 DOC-NP200-V2 NP-200 v2 第 5 页：7.1 Communication and sampling faults. Missing samples, out-of-order timestamps, or a
cleared communication alarm with n。
- 历史案例 CASE-H-010：NP-200 轴承磨损合并温度传感器漂移；根因码 multi_fault。
- 历史案例 CASE-H-001：NP-200 轴承温度漂移；根因码 sensor_drift。
- 历史案例 CASE-H-002：NP-200 驱动端轴承磨损；根因码 bearing_wear。
- 历史案例 CASE-H-005：NP-200 润滑不良；根因码 lubrication。
- 历史案例 CASE-H-004：NP-200 联轴器不对中；根因码 misalignment。

## 候选根因

- [supported] sensor_drift：轴承温度传感器漂移。温度持续上升，但振动有效值与电机电流保持稳定，符合测点漂移而非机械劣化。
  - 支持证据：ev_a42dd4c2445283942bd9, ev_bb98a0495e7c760fcc15, ev_927f77f7e49bb4b65f36, ev_8b46ecf889082c792d16
  - 反证：无
  - 缺口：手持测温对比结果
- [contradicted] bearing_wear：轴承磨损（已反驳）。若为轴承磨损，振动与电流应同步上升；当前两者稳定。
  - 支持证据：无
  - 反证：ev_7bc15c854cbc354a2583, ev_1d9a7c16c2e8417d1a49
  - 缺口：振动频谱

## 检查项

- 用独立手持测温仪与在线温度对比，确认是否为传感器漂移（风险 low，需人工：是）
  - 步骤：记录在线温度 → 在同一测点用校准过的测温仪测量 → 计算偏差并记录环境温度

## 建议

- 安排仪表工程师对比测温；确认漂移后更换温度传感器，不据此更换轴承。（控制执行：disabled）

## 限制与未解决问题

- 当前为 Mock 模拟数据模式，不能作为现场维修依据。
- 当前使用 FixtureRoleRunner 预录规则推理，不是真实模型输出。
- 手持测温对比结果
- 振动频谱
