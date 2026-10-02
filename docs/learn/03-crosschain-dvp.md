# 模块 3:跨链 DvP(ERC-7573 思路)

> 学习笔记。目标:能讲清"券和钱不在一条链上时,怎样仍然做到要么都成,要么都不成",以及为什么 Peter 和 Fries 不用时间锁。

## 1. 问题从哪里来

模块 1 的原子性是**免费**得到的:券和钱在同一条链上,一笔交易里两条腿同时动,失败就整体撤销。

现实里不一定这样。2024 年欧央行的探索试验里:

- 券在**市场方的 DLT** 上(资产链);
- 钱在**央行侧**,比如联邦银行的触发方案 / T2,今天则是 Pontes(支付链)。

两条链之间**没有共同的交易**。一条链上的合约看不到另一条链发生了什么。于是又回到了"谁先交"的老问题。

## 2. 试验里最常用的方案:HTLC,以及它的问题

HTLC(哈希时间锁合约)的做法:

1. 卖方在资产链锁券,买方在支付链锁钱,两边用同一个哈希锁住;
2. 卖方要领钱,必须公开秘密(哈希的原像);
3. 买方看到秘密后,用它去领券;
4. 都加了截止时间。过期没人动,东西退回原主。

Peter 和 Fries 在 Innovation LAB 博客里指出两个问题(备考手册第 30 页):

| 问题 | 说明 |
|---|---|
| **卖方的自由期权** | 秘密在卖方手里,卖方可以在截止时间前观望市场,自己决定领不领钱。这等于白送卖方一个期权。 |
| **买方的时间风险** | 卖方领钱后,买方必须在自己的窗口内领券。如果遇到技术故障或拒绝服务攻击错过窗口,券退回卖方,卖方就同时拿到了券和钱。 |
| **窗口难设** | 超时越长越安全,但资金占用越久,效率越低。 |

## 3. ERC-7573 的思路:两把钥匙,由付款结果决定公开哪一把

**作者**:Christian Fries、Peter Kohl-Landgraf。**状态**:以太坊标准草案(Draft)。

```
          资产链(券)                          支付链(钱)
  ┌──────────────────────────┐        ┌──────────────────────────────┐
  │ AssetLockingContract      │        │ PaymentDecryptionContract     │
  │ 券锁在合约里                │        │ 存两把加密钥匙                  │
  │ 存两个哈希:                 │        │  成功钥匙 = Bob 的取券钥匙       │
  │  H(Bob 取券钥匙)            │        │  失败钥匙 = Alice 的取回钥匙     │
  │  H(Alice 取回钥匙)          │        │ 付款成功 → 请求解密成功钥匙        │
  │ transferWithKey(钥匙):      │        │ 付款失败/取消 → 请求解密失败钥匙   │
  │  哈希对上谁,券就给谁          │        └──────────────┬───────────────┘
  └────────────▲─────────────┘                       │ TransferKeyRequested
               │ 提交明文钥匙                            ▼
               │                           ┌──────────────────────────────┐
               └───────────────────────────│ 解密预言机(链下,无状态)       │
                                           │ 只解密被请求的那一把,并公开     │
                                           └──────────────────────────────┘
```

### 关键设计 1:每把钥匙由"对方"生成

| 钥匙 | 作用 | 谁生成(知道明文) | 为什么安全 |
|---|---|---|---|
| Bob 的取券钥匙 | 把券给 Bob | **Alice** | Bob 不知道明文,不付钱就拿不到券 |
| Alice 的取回钥匙 | 把券还给 Alice | **Bob** | Alice 不知道明文,不能付款成功后再把券拿回去 |

结果是:**每一方只知道对自己不利的那把钥匙。** Bob 就算提前用他知道的那把,也只会把券还给 Alice。测试 "the buyer only knows the seller key, which can only hurt the buyer" 演示的就是这一点。

### 关键设计 2:付款结果决定公开哪一把,而且只公开一把

支付合约的状态只能走向 `Paid`、`Failed`、`Cancelled` 中的一个,每笔交易只请求一次解密。所以不可能两把钥匙都被公开。

### 关键设计 3:没有时间锁

券锁住之后,只要还没付款,Alice 随时可以 `cancelAndDecrypt`,拿到取回钥匙。不需要设置截止时间,也就没有自由期权和错过窗口的问题。

### 关键设计 4:预言机是"无状态"的

预言机不保存任何交易数据。每次请求自带一把加密钥匙,它只做三件事:

1. 解密;
2. 检查钥匙文档里写的合约地址和交易编号,是否和这次请求一致;
3. 检查方向:付款成功时,只肯公开 `releaseTo: buyer` 的钥匙。

它知道的东西越少,就越容易被运营、审计,也越难成为单点风险。论文里还提到,可以用门限解密,让多个预言机共同完成,避免只信任一方。

### 关键设计 5:卖方在支付链上再确认一次

买方在支付链上登记两把加密钥匙。如果买方动手脚,把失败钥匙换成一把假的,那么付款失败时 Alice 拿到的是废钥匙,券就永远锁住了。所以 Alice 必须在支付链上 `confirmTransfer`,**逐字节核对两把加密钥匙**。不一致就拒绝(测试:"the seller refuses a payment whose failure key differs…")。

## 4. 协议的 8 步(网页上的 Cross-chain DvP 标签)

| # | 在哪里 | 谁 | 做什么 |
|---|---|---|---|
| 1 | 链下 | 双方 | 各自为对方生成钥匙,只分享哈希和加密后的版本 |
| 2 | 资产链 | Alice | `inceptTransfer`:提出条款,登记自己取回钥匙的哈希 |
| 3 | 资产链 | Bob | `confirmTransfer`:确认同样条款,登记取券钥匙哈希,券被锁住 |
| 4 | 支付链 | Bob | `inceptTransfer`:登记付款和两把加密钥匙 |
| 5 | 支付链 | Alice | `confirmTransfer`:核对两把加密钥匙 |
| 6 | 支付链 | Bob 或 Alice | `transferAndDecrypt` 付款,或 `cancelAndDecrypt` 取消 |
| 7 | 链下 | 预言机 | 解密被请求的那一把,`releaseKey` 公开 |
| 8 | 资产链 | 任何人 | `transferWithKey`:哈希对上谁,券就给谁 |

终端版:`npm run crosschain`,会依次跑成功、付款失败、卖方取消三个场景。

## 5. 和原版 ERC-7573 的差别(面试要主动说)

- 原版金额是 `int`,还带一个 `transaction` 描述字段;支付合约确认时有回调接口。我简化成 `uint`,去掉了回调。
- 原版钥匙文档是 XML;我用 JSON:`{contract, id, releaseTo, nonce}`。
- 预言机用 RSA-OAEP 加密,是一个 Node 脚本,不是门限解密。
- 两条"链"是本地的两个 ganache 账本(链 ID 7001 和 7002),用同一套助记词,所以同一个人在两条链上地址相同。单元测试里两组合约放在同一条链上,但它们从不互相调用,唯一的连接就是钥匙。
- 锁定之后不能直接取消资产链上的交易,只能走支付链的取消流程拿取回钥匙。

## 6. 自测题

1. HTLC 里卖方的"自由期权"具体是什么?ERC-7573 为什么没有?
2. 如果 Bob 自己生成"Bob 的取券钥匙",会出什么问题?
3. 预言机被黑客控制,最坏会发生什么?门限解密怎么缓解?
4. 为什么 Alice 必须在支付链上再确认一次两把加密钥匙?
5. 第 8 步谁来提交钥匙都可以,为什么不用限制调用者?
6. 用一句英文说明:为什么锁的是资产侧,而决定结果的是资金侧?(提示:付款是否完成,只有支付链知道。)

## 7. 动手练习

1. 网页上跑三遍:价格 1000(成功)、价格 9000(失败)、第 6 步选 "Alice cancels instead"。每次都看右边 "The two keys" 哪一把变绿。
2. 在第 3 步之后、第 6 步之前,问自己:这时候 Bob 有没有办法拿到券?Alice 有没有办法拿回券?
3. **代码练习**:给 `PaymentDecryptionContract` 加一个 operator 角色(比如支付基础设施运营方),只有它能调用 `transferAndDecrypt`。这对应 2026 年 9 月那篇论文里"参与者自己运营连接器"的讨论:谁来触发结算,是一个治理问题。

## 8. 面试说法

> "On one ledger, DvP is atomic for free. Across two ledgers there is no shared transaction, so you need a protocol. HTLCs use deadlines, which give the seller a free option and put the buyer at risk of missing a window."

> "In ERC-7573 the asset is locked against two keys. Each key is written by the counterparty, so nobody holds the key that would benefit themselves. The payment outcome decides which key a stateless oracle decrypts. No time-lock, and only one key is ever released."

> "I implemented a simplified version on two local ledgers to understand it. The part I found most elegant is that the oracle doesn't need to know anything about the trade. I'd be curious how you see the operator question: should the participants run the connector, or the payment infrastructure?"

最后一句是向 Peter 提问,直接接到他 2026 年 9 月的连接器论文。
