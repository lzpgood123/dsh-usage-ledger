# 只统计带用量的 assistant/message

重试会为同一个 (turn, step) 产生若干 `assistant/attempt` 与最终的 `assistant/message`。本插件只统计**带 `usage` 的 `assistant/message`**。

全量实测：593 条 `assistant/attempt` 中带 usage 的为 **0 条**，失败尝试不计费；而 `assistant/message` 在会话内 (turn, step) 唯一。两者都算会把重试过的请求计两遍。

因此也不需要按 (turn, step) 去重——只认一种事件，唯一性天然成立。
