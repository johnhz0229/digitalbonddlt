# Smart Bond Lab:按试点报告复现的完整生命周期

> 这是项目的"正式版"。前面四个模块是学习过程;Lab 把它们整合成一只完整的债券,从融资曲线到赎回,按 DZ BANK / KfW 2026 年 3 月 Smart Bond Contract 试点报告描述的架构**小规模复现**。
>
> 运行:`npm run lab`(终端,两条分开的账本);`npm run demo` 后打开 `http://127.0.0.1:3000/lab`(网页)。

---

## 1. 面试时的一句话定位

> "I rebuilt the architecture described in your March pilot report at small scale, to understand it end to end: a factory with Treasury's funding levels, one contract instance per trade with an explicit state machine, infrastructure participants that react to events with their own keys, and cash locked on a separate payment ledger. Along the way I ran into a few questions the report leaves open."

**注意**:这是"按公开报告复现架构",**不是**试点的代码,也没有看过试点的代码。

---

## 2. 架构

```
 参与者(各自用自己的密钥,对事件做出反应,没有中心编排者)
 ┌────────────┬────────────┬────────────┬────────────────┬──────────────────┬──────────────────┐
 │Group       │投资人      │ISIN 代理   │登记机构         │解密预言机          │发行人/投资人      │
 │Treasury(人)│(人)       │(自动)     │(自动)          │(自动,无状态)     │各自的连接器(自动) │
 └─────┬──────┴─────┬──────┴─────┬──────┴───────┬────────┴─────────┬────────┴─────────┬────────┘
       ▼            ▼            ▼              ▼                  ▼                  ▼
 资产账本 7101: SmartBondFactory ──部署──▶ SmartBondContract(每笔交易一个)  BondToken(登记机构部署)
 支付账本 7102: TokenisedEuro + CashLock(模拟联邦银行触发方案:凭两个哈希锁定现金)
```

| 文件 | 作用 |
|---|---|
| `contracts/lab/SmartBondFactory.sol` | 发行计划;**各期限的指示性融资水平**;投资人准入;每笔交易部署一个实例 |
| `contracts/lab/SmartBondContract.sol` | 显式状态机;条款记录与哈希;发行、付息、赎回都用同一种结算模式 |
| `contracts/lab/BondToken.sol` | 登记机构部署;只有登记机构能铸币和维护准入名单;只有债券合约能移动和销毁 |
| `contracts/lab/CashLock.sol` | 支付侧:现金凭成功/失败两个哈希锁定,不可撤回 |
| `scripts/lab/participants.js` | 五个自动参与者 + 把事件送达所有人的 `Network` |
| `scripts/lab/lab.js` | 两个人的操作(Treasury、投资人)和状态视图 |
| `test/lab/SmartBondLab.test.js` | 13 个测试:完整生命周期、错误锁定后重试、状态 × 角色、防护 |

### 状态机(每个状态只允许一个角色推进到下一步)

| 状态 | 由谁、用什么推进 |
|---|---|
| IndicationPhase | 投资人在 Factory 请求交易,实例被部署 |
| → TradeIncepted | Treasury `inceptTrade`:最终条款记录 + 利率 + 发行日 |
| → DistributionPhase | 投资人 `confirmTrade(条款哈希)`,此后条款不可改(ERC-6123 的 incept/confirm 思路) |
| → IsinAssigned | ISIN 代理 `assignIsin` |
| → Minted | 登记机构部署代币、铸给发行人,`registerToken`;同时自动开启发行结算 |
| → Issued | 发行结算成功:代币交付给投资人 |
| → Redeemed | 两期利息都解除之后,赎回结算成功,代币被销毁 |
| Cancelled | 条款确认之前,任一方可取消 |

### 一种结算模式,用于发行、付息、赎回

1. 债券合约请求钥匙,预言机生成成功/失败两把钥匙,只上传哈希和密文(`commitKeys`)。
2. **付款方**在支付账本上凭这两个哈希锁定现金(发行:投资人;付息和赎回:发行人)。
3. **收款方自己的连接器**在支付账本上核对:付款方、金额、两个哈希是否和债券合约里的完全一致。核对通过才 `attestCashLock`,然后触发 `settle`。
4. 债券合约执行资产侧动作(发行:交付代币;赎回:收回并销毁;付息:无),然后只请求一把钥匙。
5. 预言机核对后公开钥匙,债券合约**接受成功原像才算债务解除**(付款对解除)。
6. 收款方用成功钥匙领取现金;如果失败,付款方用失败钥匙取回现金。

试点报告原话:付息和赎回时,"the described DvP process runs in reverse"。

---

## 3. 用户故事(请你审阅、改写成你自己的话)

> 这些是我先写的草稿。面试前请你**逐条用自己的话重写一遍**,这是你在这个项目里最核心的工作。

**US-1 融资水平(Group Treasury)**
As Group Treasury, I want to publish indicative funding levels per tenor on-chain, so that eligible investors can request bonds at a known price without a bilateral negotiation for every trade.
- Given 2Y 的水平已发布为 3.10%、最多 500 份,When 准入的投资人请求 100 份,Then 部署一个新实例,指示利率 3.10%
- Given 投资人未准入,When 请求交易,Then 被拒绝(`NotEligible`)
- Given 请求 501 份,Then 被拒绝(`InvalidUnits`)

**US-2 条款确认(投资人)**
As an investor, I want to confirm exactly the terms record I have checked, so that nobody can change the terms afterwards.
- 投资人的连接器核对条款记录(JSON)和合约里实际执行的数值(利率、份数、日期、地址),不一致就不确认
- 确认的是条款记录的哈希;确认后状态进入 DistributionPhase,条款不可再改

**US-3 发行 DvP(双方)**
As an issuer, I want the units delivered only when the purchase price is irrevocably locked for me, so that I never deliver without being paid.
- Given 投资人锁定的金额少于价格,Then 发行人的连接器拒绝确认锁定,不交付任何东西
- Given 拒绝之后,When 投资人中止,Then 失败钥匙被公开,投资人取回现金;之后可以重试
- Given 锁定正确,Then 代币交付给投资人,成功钥匙把现金释放给发行人

**US-4 付息与赎回(投资人)**
As an investor, I want each coupon and the principal to count as paid only when the bond itself accepts the success key, so that a reported "paid" status alone can never discharge my claim.
- 付息日之前不能开启结算(`NotDue`);利息按顺序支付
- 发行人的现金没锁定时,结算一直停在"等待现金",债权保持 OUTSTANDING
- 到期且两期利息都已解除,才能赎回;赎回时代币被销毁

---

## 4. 我自己的分析:先锁资产 vs 先锁现金

模块 3 是**先锁资产**(按 ERC-7573 EIP 页面的描述),Lab 是**先锁现金**(按试点报告)。

| 方面 | 先锁资产(模块 3) | 先锁现金(试点 / Lab) |
|---|---|---|
| 谁先做出不可撤回的承诺 | 卖方:券被锁 | 买方:现金被锁 |
| 谁决定结果 | 支付侧合约执行付款,结果由它确定 | 资产侧合约在交付资产后请求钥匙 |
| 对支付系统的要求 | 需要能执行条件付款、发出事件的支付合约 | **只需要"凭哈希锁定、凭原像释放"**,这正是触发方案提供的能力 |
| 等待期间占用什么 | 卖方的券 | 买方的流动性(对 Treasury:付息和赎回时是发行人的现金) |
| 预言机离线会怎样 | 已付款,但暂时拿不到券 | 已交付券,但现金暂时没释放(锁定不可撤回,只是延迟) |
| 外部状态由谁验证 | 支付合约自己 | **必须有人确认"现金确实锁好了"** |

**我的结论**:先锁现金,对央行侧基础设施要求更低,因为支付系统不需要运行智能合约。这可能就是试点选择它的原因(这是我的推测,可以向他求证)。

---

## 5. 一个真正值得问 Peter 的问题

在先锁现金的模式里,资产侧合约看不到支付账本。那么**它怎么知道现金真的锁好了?**

- 我的设计:由**收款方自己的连接器**验证并确认。理由是:如果锁定是假的,受损的是收款方,所以应该由收款方来验证(Lab 里发行人连接器拒绝 €90,000 那一步,演示的就是这个)。
- 试点报告里 KfW 的原话是:"Once we locked our payment on the Bundesbank infrastructure and confirmed it via the Smart Bond interface, the delivery took place automatically." 听起来是**付款方(投资人)**确认的。

> "In the cash-lock model, the bond contract can't see the payment ledger. In my version the payee's connector attests the lock, because the payee would lose from a fake one. In the report it sounds as if the investor confirmed it. How does the Smart Bond Contract know the cash is really locked?"

这个问题是真诚的,我确实不知道答案。它同时证明你读过报告、理解风险分配,也和他 9 月"参与者运营的连接器"那篇论文直接相关。

---

## 6. 和试点的差别(主动说)

| 方面 | Lab | 试点(报告) |
|---|---|---|
| 账本 | 两个本地账本 | Polygon PoS + T2(触发方案) |
| 现金侧 | `CashLock` 合约模拟 | 联邦银行触发方案,央行货币,不是 EVM 合约 |
| ISIN | 本地生成,格式和校验位正确,但不是真的 | WM Datenservice 链上分配 |
| 铸币 | 登记机构机器人链上部署 | Cashlink 通过链下 API 收到请求,下一轮迭代目标完全上链 |
| 条款 | 简化 JSON,受 BDT 启发,未按模式校验 | ICMA BDT XML + XSLT |
| 确认 | 投资人确认条款哈希 | 报告:按 ERC-6123 做基于哈希的双边确认 |
| 投资人数 | 每个实例一个投资人,不支持二级转让 | 一笔私募(KfW) |
| 计息 | 年付,规则期间利息 = 名义金额 × 利率 | 按条款 |

---

## 7. 演示讲稿(网页 `/lab`,约 4 分钟)

右上角的 **NEXT STEP** 会一直提示下一步该点什么。

1. **Treasury 发布融资曲线**:"This is where Funding Management meets the protocol."
2. **准入投资人 → 请求 100 份 2Y**:Factory 部署一个独立实例。
3. **Incept → Confirm**:展示下方的条款记录和哈希。"The investor's connector checks that the record says what the contract enforces, then confirms the hash."
4. **观察右侧的参与者面板**:ISIN、代币、钥匙,全部自动出现。"Nobody clicked for them."
5. **锁 90,000(错误金额)**:发行人连接器拒绝。中止,现金退回;重试,锁定正确金额,完成发行。
6. **时钟 → 付息**两次,看利息计划逐期变成 DISCHARGED。
7. **到期 → 赎回**:代币销毁,状态变成 Redeemed。
8. **收尾**:讲第 4 节的对比和第 5 节的问题。

---

## 8. 自测题

1. 为什么每笔交易部署一个独立实例,而不是一个大合约管理所有债券?
2. 条款确认为什么用哈希?投资人的连接器还额外检查了什么?为什么需要?
3. 发行结算里,为什么是**发行人**的连接器验证投资人的现金锁定?
4. 预言机离线一天,发行、付息、赎回分别会卡在哪一步?谁会损失什么?
5. `BondToken.transfer` 为什么直接拒绝?生产环境需要什么?
6. 用一句英文解释:先锁现金为什么对央行基础设施的要求更低?
