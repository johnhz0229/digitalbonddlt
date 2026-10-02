# 模块 1:同链 DvP(券款对付)

> 学习笔记。目标:能不看稿讲清"为什么需要 DvP、代码怎么实现、失败时怎么办"。

## 1. 业务问题

卖方(Treasury)卖 10 份债券给买方(保险公司),总价 1000 万欧元。

| 顺序 | 风险 | 谁承担 |
|---|---|---|
| 卖方先交券 | 买方不付钱,卖方损失整笔本金 | 卖方 |
| 买方先付钱 | 卖方不交券,买方损失整笔本金 | 买方 |

**本金风险**(principal risk / Erfüllungsrisiko):交了货却收不到对价,损失的是交易的全部价值。

**注意区分重置成本风险**:对方在交易后、结算前违约,你得按新市场价重新成交,损失的是价差。DvP 解决本金风险,不解决重置成本风险。

传统解决方案:CSD / T2S 作为中介,同时看住券和钱。
本项目的方案:用一个合约,在**同一笔交易**里交换两条腿,不存在"中间那段时间"。

## 2. 我们一起写的需求

```
Story:
As a seller, I want the bond delivery and the cash payment to settle in one
atomic step, so that I never deliver bonds without receiving payment.

AC1 成功:双方确认同一笔交易、余额和授权都足够 → 一笔交易内双方券和钱同时变化,状态"已结算"
AC2 买方钱不够 → 不交割,余额不变,记录失败及原因
AC3 卖方券不够 → 同上
AC4 买方不在白名单 → 同上(合规失败)
AC5 条款不一致 / 买方未确认 → 不能结算
```

产品决策:**方案 B,失败要留记录**。理由:运营团队需要知道每一笔交易是否成功、为什么失败。

## 3. 需求 → 代码 → 测试

| 需求 | 代码(`contracts/DvPSettlement.sol`) | 测试(`test/DvPSettlement.test.js`) |
|---|---|---|
| 卖方提出条款 | `proposeTrade(buyer, units, cashAmount)` | 所有测试的前置步骤 |
| AC5 买方确认同一条款 | `confirmTrade(id, units, cashAmount)`,条款不同就 `TermsMismatch` | "rejects a confirmation with different terms" |
| AC5 未确认不能结算 | `settle()` 要求状态是 `Confirmed` | "cannot settle a trade the buyer has not confirmed" |
| AC2–AC4 先检查,失败记录原因 | `checkSettlement()` 返回 `FailureReason`;`settle()` 把状态设为 `Failed` 并发出 `SettlementFailed` | AC2、AC3、AC4 三组测试 |
| AC1 两条腿一起动 | `settle()` 里的两行 `transferFrom` | "swaps bonds and cash and records the trade as settled" |

交易状态机:

```
Proposed ──confirmTrade──▶ Confirmed ──settle──▶ Settled
   │                           │
   └──cancelTrade──▶ Cancelled └──settle(检查不通过)──▶ Failed
```

## 4. 三个关键理解

**(1) "授权"就是你说的"列为可以交换"。**
ERC-20 的 `approve(spender, amount)`:我允许某个合约最多从我这里拿走 amount。
DvP 合约不需要先把券和钱收进来保管。卖方授权券,买方授权钱,结算那一刻合约用 `transferFrom` 同时划转。

**(2) 原子性来自"交易"本身,不是我们写的代码。**
`settle()` 里如果第二个 `transferFrom` 失败,整笔交易(包括已经改掉的状态、已经划转的第一条腿)全部撤销。这是 EVM 的规则:一笔交易要么全部生效,要么完全不生效。

**(3) 方案 B 的代价:撤销会把"失败记录"也一起撤销。**
所以失败的情况不能用 revert,只能**先检查,不满足就记录失败并正常返回**。代码里的顺序是:
1. `checkSettlement()` 检查白名单、余额、授权;
2. 不通过 → 状态记为 `Failed`,发出事件,`return false`;
3. 通过 → 两条腿 `transferFrom`。如果还有任何意外,revert 仍然兜底,保证不会只动一条腿。

**更正**:我之前说"检查完之后的瞬间情况可能变化"。在同一笔交易里不会,因为没有别人能在中间插进来,所以检查结果在划转时依然成立。剩下的风险只来自代币合约本身有我们没预料到的额外规则,这就是保留 revert 兜底的原因。

## 5. 自测题(先自己答,再看代码)

1. 买方授权了 1000 万但余额只有 900 万,`checkSettlement` 返回什么?
2. 为什么 `confirmTrade` 要求买方再输入一遍数量和价格,而不是只点"确认"?
3. 一笔 `Failed` 的交易能再结算一次吗?你作为 PO,觉得应该允许吗?
4. 如果把 `settle()` 里的检查删掉,只保留两行 `transferFrom`,AC1 还成立吗?AC2 呢?
5. 用一句英文解释:DvP 消除了哪种风险,没有消除哪种风险?

## 6. 动手练习

在 demo 里(`npm run demo` → Live workflow):
1. Approve Alice 和 Bob,给 Alice 发 10 份。
2. Alice 以 400 欧卖 4 份给 Bob:Propose → Bob confirms → 两个 authorise → Settle。看两边余额同时变化。
3. 再提一笔 9000 欧的交易。授权之后先看 **Pre-check** 提示什么,再按 Settle,看 blotter 里的 FAILED 和原因。
4. 另试:只授权一边就 Settle,会记录什么原因?

**代码练习**:给交易加一个截止时间。超过截止时间还没结算的交易,`settle()` 应该记录为失败,原因是 `Expired`。
提示:`Trade` 加一个字段 `deadline`,`FailureReason` 加一个值,`checkSettlement` 加一行判断,再写一个测试。

## 7. 面试说法

> "Settlement risk exists because the two legs happen at different times. A CSD solves it by standing in the middle; a smart contract removes the 'middle', because both legs settle in one transaction."

> "I made a deliberate product decision: a failed settlement is recorded with a reason instead of simply reverting, because operations needs to see every attempt. That meant checking all preconditions first, while keeping the revert as a safety net."

> "This only works because bond and cash live on the same ledger. When they don't, you need something like ERC-7573, which is the next module."

最后一句就是通往模块 3(跨链 DvP)的桥。
