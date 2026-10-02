# 模块 4:付息的"付款对解除"(Payment versus Discharge)

> 学习笔记。目标:能讲清"什么时候一期利息才算真正付过",以及这和 DZ BANK / KfW 2026 年 3 月的 Smart Bond Contract 试点是什么关系。

## 0. 先说依据(面试时要分清"读到的"和"自己理解的")

| 来源 | 我读到了什么 |
|---|---|
| **Smart Bond Contract 试点报告,2026 年 3 月**(DZ BANK 与 KfW,KfW 官网 PDF) | **全文**。下面第 1 节的事实都来自这份报告。 |
| Fries、Kohl-Landgraf、Prandtl,《Participant-Operated Settlement Connectors for Digital Bonds》,2026 年 9 月 | **只有摘要**(来自备考手册第 28 页)。"付款对解除"这个概念出自这里。 |
| ERC-7573 原文 | 接口和流程(模块 3 已用到) |

本模块的合约,是我**根据论文摘要和试点报告做出的理解**,不是论文的实现。面试时请这样说:"This is my reading of the abstract, implemented to understand it."

## 1. 试点报告里的关键事实(值得背下来)

- **时间与参与方**:2026 年 3 月。DZ BANK 是发行人,KfW 是投资人。WM Datenservice 提供 ISIN,Cashlink 是加密证券登记机构,联邦银行提供触发方案(T2 里的央行货币结算),NTT DATA 托管解密预言机。共 **6 个参与方**,点对点交互,**没有中心化运营方**。
- **法律性质**:具有法律约束力的一级市场交易。依据德国电子证券法 eWpG 第 4 条第 3 款发行的加密证券,**ISIN DE000SBC0DZ4**。
- **基础设施**:公链 **Polygon PoS**,部署了 **5 个合约**:Smart Bond Factory、Smart Bond Contract(生命周期状态机)、ERC-20 Token Registry、Smart ISIN Contract、Decryption Oracle Contract。
- **结果**:**40 分钟内完成发行结算**,T+0;生命周期走过 **9 个功能状态**。
- **跨链 DvP**:基于 ERC-7573。投资人先在联邦银行触发方案上**锁定现金**(凭一个哈希锁住);Smart Bond Contract 确认债券已转给投资人之后,请求解密钥匙;钥匙一公开,现金就被释放。报告原话:"Cash is irrevocably locked before asset transfer — principal risk structurally eliminated."
- **预言机**:由**预言机生成**加密钥匙和对应哈希;只有 Smart Bond Contract 有权请求解密。NTT Data 的原话:不需要看到交易经济条款或对手方身份,而且"fully replaceable without any contract redeployment"。
- **付息与赎回**:"the described DvP process runs in reverse"。发行人生成钥匙对、锁定现金,任何一方都可以通过 Smart Bond Contract 触发;如果条件允许,预言机就释放钥匙,由投资人领取。赎回时代币被销毁,状态变为 `Redeemed`。
- **生命周期状态**里出现了 `IndicationPhase` 和 `DistributionPhase`。交易确认用的是 **ERC-6123 的 `inceptTrade` / `confirmTrade`**。
- **发行条款**:按 **ICMA Bond Data Taxonomy (BDT)** 的 XML 格式存在链上,作为单一数据源。
- **对你最重要的一条**:报告的联系人名单里,**Peter Kohl-Landgraf 属于 Group Treasury**(Fries 和 Prandtl 属于 Group Risk Control)。这就回答了备考手册里那个待核实的问题:他就在你应聘的 Konzern-Treasury。

## 2. 问题:利息什么时候才算付过?

现金在支付链上流动,债务记在债券(资产链)上。两边是分开的。

如果债券只是相信别人报告的"已付"状态:
- 报告错了,或者被伪造了,投资人的利息债权就被错误地抹掉了;
- 付款明明失败了,却被当成"已付",投资人一分钱也拿不到。

论文摘要里的规则是:**结算状态本身不能解除利息债权。** 只有债券合约自己独立验证并接受了"成功原像",才能把这期利息记为已付。

这就是 **Payment versus Discharge**:付款,对应的是"解除债务"。它和 DvP 很像,只是另一边换成了"债务的解除",而不是"券的交付"。

## 3. 这个模块怎么做

```
  资产链:CouponDischarge(债务)                支付链:PaymentDecryptionContract(现金)
  1 登记日 recordCoupon:固定每人的利息债权
  2 openAttempt:为 Alice 开一次结算尝试
  3 预言机生成成功/失败两把钥匙,
    commitOutcomeKeys:债券冻结两个哈希   ───加密钥匙──▶ 4 发行人 inceptTransfer
                                                     5 Alice 的连接器 confirmTransfer
                                                       (核对加密钥匙 = 债券上冻结的那两把)
                                                     6 transferAndDecrypt:付款成功或失败
                                                     7 预言机只解密一把,releaseKey 公开
  8 Alice 的连接器 submitOutcome(原像) ◀───────────── 钥匙
    成功原像 → 债权解除(DISCHARGED)
    失败原像 → 本次尝试关闭,债权仍然有效(OUTSTANDING),可以重开一次尝试
```

`npm run coupon` 会在终端跑两个故事;网页上对应 **Coupon discharge** 标签。

### 四个关键设计

**(1) 登记日固定债权。** `recordCoupon` 在付息日读取持有人名册,固定每个人这一期应收多少。之后即使转让债券,这一期的债权人也不变(测试:"fixes each holder's claim at the record date")。

**(2) 冻结结果承诺,而且没人知道原像。** 两把钥匙由预言机生成,生成后立刻丢弃明文,债券上只存哈希。所以发行人无法"伪造已付",投资人也无法"伪造失败"。这和试点的做法一致。

**(3) 失败只关闭这次尝试,不解除债权。** 这条规则是让系统安全的关键:就算失败钥匙被用了,最坏结果也只是"再试一次",不会让任何人损失债权。

**(4) 转发是幂等的(idempotent)。** 连接器把钥匙送回债券时可能超时,不知道是否送达。再送一次也没有副作用(测试:"forwarding the same key again is a harmless no-op")。这对运营很重要:**失败后可以放心重试**。摘要里"可重复的密钥转发"大概就是这个意思。

### 最关键的一刻

在第 6 步之后、第 8 步之前,看网页右边:
- 支付链:**PAID**,Alice 已经收到 €73.92;
- 债券:**OUTSTANDING**。

钱已经到了,债务还没解除。直到债券自己接受成功原像,才变成 **DISCHARGED**。这正是"结算状态不能解除债权"。

## 4. 回头看模块 3:一个我之前没讲到的局限

模块 3 里,每把钥匙由**对方**生成(依据 2024 年 1 月那篇博客的通俗版)。这样有个问题:**收到钥匙的一方无法验证"哈希"和"加密钥匙"是否对应同一个明文。** 比如 Bob 给 Alice 的取回钥匙,哈希和密文如果不对应,付款失败时 Alice 拿到的钥匙就打不开锁,券会被永远锁住。

试点的解决办法是:**由预言机生成钥匙对**。它保证哈希和密文一致,并且不保留明文。模块 4 就采用了这种方式。这是一个很好的面试话题:同一个协议,在"谁生成钥匙"这一点上有不同的设计取舍。

## 5. 和真实试点的差别(主动说)

- 试点里现金是在联邦银行触发方案上**先锁定**,再凭钥匙释放。我的支付链是"先付款,再根据结果请求钥匙",复用了模块 3 的合约。两种方式都是"一笔现金结果对应一把钥匙",但锁定的时点不同。
- 试点里债券、登记、ISIN 都由 Smart Bond Contract 统一编排。我只做了付息这一段。
- 论文里"参与者自己运营的连接器"是一个架构问题。我只是把"谁转发钥匙"标成了 "Alice's connector"。
- 我的登记日逐个读取持有人,只适合少量持有人的演示。

## 6. 自测题

1. 为什么不能让发行人直接调用一个 `markCouponPaid()`?
2. 如果投资人知道成功原像,会发生什么?对谁不利?(提示:比较模块 3 里"每一方只知道对自己不利的钥匙"。)
3. 失败原像为什么可以"只关闭尝试,不解除债权"?如果失败也解除债权,会出什么问题?
4. 连接器转发钥匙后超时了,不知道债券有没有收到。它应该怎么办?为什么安全?
5. 试点里为什么要"先锁定现金",再转券?这和本金风险有什么关系?
6. Peter 在试点报告里属于哪个部门?这对你的面试意味着什么?

## 7. 动手练习

1. 网页上先选 "Payment fails",看债权是否仍是 OUTSTANDING;再点 "Open a new attempt",用新的一对钥匙成功完成。
2. 在第 6 步付款成功、第 8 步转发之前,停下来对比左右两边的状态。
3. **代码练习**:给 `CouponDischarge` 加上第 2 期利息(period 2),写一个测试:第 1 期解除之后,第 2 期的债权仍然有效,而且必须等到第 2 个付息日才能登记。

## 8. 面试说法

> "In your March pilot the cash was locked on the Trigger Solution before the token moved, so principal risk was structurally eliminated. For coupons, I tried to understand the idea from your new connector paper: a settlement status alone shouldn't discharge the claim. The bond only marks the coupon as paid once it accepts the success preimage itself."

> "The rule I found most important is that a failure key closes the attempt but not the claim. That makes the failure path harmless, so operations can always retry. And forwarding the key is idempotent, so a connector that timed out can just send it again."

> "I also noticed a design choice between the 2024 blog and the pilot: whether the counterparties or the oracle generate the keys. With oracle-generated keys, the hash and ciphertext are guaranteed to match. Was that the reason for the change?"

最后一个问题既能证明你读过两份材料,也是在向他请教。
