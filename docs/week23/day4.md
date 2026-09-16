# 第 23 周 · Day 4：LeetCode 图 BFS/DFS 与优先队列——AI 岗最该拿的算法分

> 对应手册任务：学习「LeetCode：图 BFS/DFS + 优先队列」，动手刷 3 道图题 + 2 道堆题，当日产出 5 道 AC。本篇只解决一个问题：AI 岗的算法题确实比后端简单一档，但不是不考——图和优先队列恰好是 Agent 岗出现率最高的两类题，因为图就是多 Agent 之间的关系网，优先队列就是任务调度的直觉。今天用一套模板加一张 heapq 速查表，把 5 道经典题全部拿下。

## 今日目标

1. 手写 BFS/DFS 通用模板：邻接表建图、visited 标记时机、队列 vs 栈的分工，说得清两者各适合什么场景
2. 掌握 heapq 的 5 个核心 API，能徒手维护「大小为 k 的最小堆」，不把方向搞反
3. 独立 AC 5 道题：200 岛屿数量、207 课程表、133 克隆图、215 第 K 大、239 滑动窗口最大值，每道都是先讲思路再写代码

## 概念讲解：为什么 AI 岗最爱考图和堆

先摆事实：AI 岗的算法门槛低于后端。Hard 级别的判题、线段树、复杂 DP 基本不出现，LeetCode 中等难度就是天花板。但「低于后端」不等于「没有」，而且考点分布很偏——面试官不是随机抽题，是专挑和 Agent 工作沾边的出。

多 Agent 系统的本质是图。Agent 之间谁调用谁、消息怎么传递、任务先依赖谁后依赖谁，画出来全是节点和边，遍历一张图就是遍历 Agent 关系网。任务调度的本质是优先队列：一批任务谁先执行、LLM 请求按什么顺序处理、检索结果怎么取 TopK，底层全是堆。Day 3 白板设计的排行榜（见 [Day 3](/week23/day3)），核心就是 TopK 问题，今天的第 4 题直接对口。

所以这两类题是性价比最高的算法分：模板少、套路固定、5 道题就能覆盖主要题型。面试官也不指望你写得完美无缺，他要的是你听到「多 Agent 依赖」时脑子里自动浮现拓扑排序——这个直觉比多背十道题值钱。

## 核心知识

本节的模板代码是后面三道图题的公共骨架，先在本地 Python 环境跑通，再进动手任务。

### 1. 一套模板打天下：邻接表 + visited + 队列/栈

先解决图怎么存。面试手写用邻接表：`graph[u]` 是 u 能直达的节点列表。二维网格不用显式建表，格子 `(r, c)` 的邻居就是上下左右四格，天然是图。

```python
from collections import deque

n = 5                                    # 节点数
edges = [(0, 1), (0, 2), (1, 3), (3, 4)] # 边列表

graph = [[] for _ in range(n)]
for u, v in edges:
    graph[u].append(v)
    graph[v].append(u)  # 无向图保留这行，有向图删掉

visited = set()

def bfs(start):              # 队列驱动，一层层向外扩散
    q = deque([start])
    visited.add(start)
    while q:
        cur = q.popleft()
        print(cur)           # 处理 cur
        for nxt in graph[cur]:
            if nxt not in visited:
                visited.add(nxt)  # 标记时机：入队时，不是出队时
                q.append(nxt)

def dfs(cur):                # 递归栈驱动，一条路走到黑
    if cur in visited:
        return
    visited.add(cur)
    print(cur)
    for nxt in graph[cur]:
        dfs(nxt)
```

关键差异一行说清：BFS 用队列，先进先出，按离起点的距离一层层扩散，要算「最少几步」必须用它；DFS 用栈，递归就是隐式栈，先扎到底再回头，代码更短，适合「把所有可达的都跑一遍」。复杂度都是 O(V+E)。最容易翻车的是 visited 的标记时机：入队那一刻就标记。拖到出队才标记，同一个节点会被塞进队列好几次，BFS 直接失真。

### 2. heapq 速查：5 个 API 覆盖九成场景

Python 的堆在标准库 heapq 里，注意它只提供最小堆。核心 API 一共 5 个：

| 想做什么 | 写法 | 说明 |
| --- | --- | --- |
| 列表原地建堆 | `heapq.heapify(a)` | O(n)，a 从此是合法最小堆 |
| 压入元素 | `heapq.heappush(h, x)` | O(log n)，自动维持堆序 |
| 弹出最小值 | `heapq.heappop(h)` | O(log n)，堆顶出列 |
| 只看不取最小值 | `h[0]` | O(1)，空堆别看 |
| 要最大堆 | 存负数：入 `-x`，出再取负 | 库里没有现成最大堆 |

两个补充：`heapq.heappushpop(h, x)` 等于先 push 再 pop，一步到位；取前 k 大直接 `heapq.nlargest(k, nums)`，一行写完但要 O(n log k)。记一条性质：堆只保证 `h[0]` 是最小，其余位置不是有序的，别拿堆切片当排序用。

## 动手任务：5 道 AC 一步一步

手册任务：刷 3 道图题 + 2 道堆/队列题。按顺序刷：200 → 207 → 133 → 215 → 239，前三道共用上面那套模板，手感是连着的。每道题的节奏固定：思路 3 句、代码、复杂度、一句话记忆点。

**第 1 题：200. 岛屿数量（中等）。** 网格里 `'1'` 是陆地，问有几座岛（连通块）。外层双循环扫格子，遇到 `'1'` 说明发现新岛，计数加一，然后用遍历把整座岛「淹掉」，保证不会被数第二次。淹岛就是 DFS 或 BFS：把连通的 `'1'` 全改成 `'0'`。

DFS 沉岛版：

```python
class Solution:
    def numIslands(self, grid: List[List[str]]) -> int:
        rows, cols = len(grid), len(grid[0])

        def dfs(r: int, c: int) -> None:
            if r < 0 or r >= rows or c < 0 or c >= cols or grid[r][c] != '1':
                return
            grid[r][c] = '0'          # 沉岛：改值即标记，visited 都省了
            dfs(r + 1, c); dfs(r - 1, c)
            dfs(r, c + 1); dfs(r, c - 1)

        count = 0
        for r in range(rows):
            for c in range(cols):
                if grid[r][c] == '1':
                    count += 1
                    dfs(r, c)
        return count
```

BFS 版，把递归换成队列，网格特别大时更稳：

```python
from collections import deque

class Solution:
    def numIslands(self, grid: List[List[str]]) -> int:
        rows, cols = len(grid), len(grid[0])
        count = 0
        for r in range(rows):
            for c in range(cols):
                if grid[r][c] == '1':
                    count += 1
                    grid[r][c] = '0'
                    q = deque([(r, c)])
                    while q:
                        x, y = q.popleft()
                        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                            nx, ny = x + dx, y + dy
                            if 0 <= nx < rows and 0 <= ny < cols and grid[nx][ny] == '1':
                                grid[nx][ny] = '0'  # 入队前就沉岛
                                q.append((nx, ny))
        return count
```

复杂度：两版都是 O(M×N)，每个格子至多进出一次；空间上 DFS 是递归栈，最坏全陆地 O(M×N)，BFS 是队列，最坏 O(min(M, N))。

一句话记忆点：数岛就是数连通分量，沉岛是免费的 visited。

**第 2 题：207. 课程表（中等）。** 先修关系是一张有向图，「能不能修完」等价于「图里有没有环」。用拓扑排序的 BFS 写法（Kahn 算法）：统计每个节点入度，入度为 0 的课没有先修要求，先进队列；每出队一门，把它指向的课入度减一，减到 0 就进队。出队总数凑齐课程数就无环。

```python
from collections import deque

class Solution:
    def canFinish(self, numCourses: int, prerequisites: List[List[int]]) -> bool:
        graph = [[] for _ in range(numCourses)]  # 邻接表：b -> a
        indegree = [0] * numCourses
        for a, b in prerequisites:   # [a, b]：修 a 前得先修 b
            graph[b].append(a)
            indegree[a] += 1

        q = deque(i for i in range(numCourses) if indegree[i] == 0)
        done = 0
        while q:
            cur = q.popleft()
            done += 1
            for nxt in graph[cur]:
                indegree[nxt] -= 1
                if indegree[nxt] == 0:
                    q.append(nxt)
        return done == numCourses
```

复杂度：O(V+E)，每个节点、每条边各走一次，额外空间 O(V+E)。

一句话记忆点：入度表加队列，出队数凑齐就是无环。多 Agent 编排里「先检索、再总结、最后写稿」的执行顺序，就是这张图的拓扑序。

**第 3 题：133. 克隆图（中等）。** 深拷贝一张图，难点在环：A 的邻居是 B，B 的邻居又指回 A，朴素递归会无限循环。用哈希表 memo 记「原节点 → 克隆节点」，递归时先查表，命中就返回已有克隆。关键动作是先登记自己、再递归邻居，这样指回自己的边能立刻命中 memo，环就断开了。

```python
class Solution:
    def cloneGraph(self, node: 'Node') -> 'Node':
        if not node:
            return None
        memo = {}  # 原节点 -> 克隆节点

        def dfs(cur: 'Node') -> 'Node':
            if cur in memo:
                return memo[cur]
            copy = Node(cur.val)
            memo[cur] = copy          # 先登记，再递归，防环
            for nb in cur.neighbors:
                copy.neighbors.append(dfs(nb))
            return copy

        return dfs(node)
```

复杂度：O(V+E)，每个节点克隆一次、每条边处理一次；空间 O(V)。

一句话记忆点：带环的深拷贝，哈希 memo 既是缓存又是防环开关，登记必须放在递归之前。

**第 4 题：215. 数组中的第 K 个最大元素（中等）。** 排序取下标最直白，O(n log n)，但面试要的是 TopK 直觉。堆解法：维护大小为 k 的最小堆，遍历数组，堆里超过 k 个就弹掉堆顶，走完后堆顶恰好是第 k 大。快速选择解法：借快排的 partition，每轮只处理包含目标下标的那一侧，平均 O(n)。

```python
import heapq

class Solution:
    def findKthLargest(self, nums: List[int], k: int) -> int:
        heap = []
        for x in nums:
            heapq.heappush(heap, x)
            if len(heap) > k:
                heapq.heappop(heap)  # 弹掉当前最小的，留下最大的 k 个
        return heap[0]
```

快速选择版，平均 O(n)，随机选 pivot 后最坏 O(n²) 几乎遇不到：

```python
import random

class Solution:
    def findKthLargest(self, nums: List[int], k: int) -> int:
        target = len(nums) - k          # 第 k 大 = 升序后的下标 n-k
        left, right = 0, len(nums) - 1
        while True:
            pi = random.randint(left, right)
            nums[pi], nums[right] = nums[right], nums[pi]
            pivot, store = nums[right], left
            for i in range(left, right):
                if nums[i] < pivot:
                    nums[store], nums[i] = nums[i], nums[store]
                    store += 1
            nums[store], nums[right] = nums[right], nums[store]
            if store == target:
                return nums[store]
            elif store < target:
                left = store + 1
            else:
                right = store - 1
```

复杂度：堆是 O(n log k)、额外空间 O(k)；快速选择平均 O(n)、原地操作但会打乱数组。

一句话记忆点：TopK 就是排行榜——流式数据用大小为 k 的最小堆，堆顶永远是「还留在榜上的最后一名」。Day 3 设计的排行榜系统，底层就是这道题。

**第 5 题：239. 滑动窗口最大值（困难）。** 窗口每次右移一格，暴力做法每个窗口重扫 k 个数，O(n·k) 会超时。换「单调队列」：队列里存下标，保证从队头到队尾对应的值递减。新元素进队前，把队尾所有不大于它的全弹掉——它们比新元素小又比它旧，永远当不上最大值；队头就是当前窗口最大值，滑出窗口时及时清理。

```python
from collections import deque

class Solution:
    def maxSlidingWindow(self, nums: List[int], k: int) -> List[int]:
        q = deque()   # 存下标，对应值从队头到队尾递减
        res = []
        for i, x in enumerate(nums):
            while q and nums[q[-1]] <= x:   # 队尾没我大的全弹掉
                q.pop()
            q.append(i)
            if q[0] <= i - k:               # 队头已滑出窗口
                q.popleft()
            if i >= k - 1:
                res.append(nums[q[0]])      # 队头即窗口最大值
        return res
```

复杂度：O(n)，每个下标至多入队一次、出队一次，均摊单步 O(1)；空间 O(k)。

一句话记忆点：存下标不存值，队头到队尾递减，「比我小又比我旧」的元素没有活路。

::: tip 提交建议
每道题先自己写 15 分钟，写不出再看题解，看完合上题解重写一遍再提交——「看懂」和「写对」之间差着一整场面试。5 道 AC 之后，把提交记录截图和五份代码存进当日目录，Day 7 整理速查卡（见 [Day 7](/week23/day7)）时，图和堆的模板直接从今天抄。
:::

## 面试策略：AI 岗的算法账

先摆正定位：AI 岗算法是筛选项，不是决胜项。面试官要确认你不掉链子，不是要你秒杀 hard。所以得分逻辑和刷题竞赛相反：讲清思路的权重高于代码完美。

节奏固定四步：复述题目，确认没理解偏；先给暴力解，说出复杂度；指出瓶颈在哪、怎么优化；最后才动笔。哪怕代码带个小 bug，这套流程走下来面试官也知道思路是通的。反过来，闷头写十分钟一声不吭，就算写对了印象分也一般。

卡住时最忌讳两件事：沉默发呆和乱写一气。正确动作是把已经确定的部分说出口，把卡点压缩成一个具体的问题抛回去。比如：「这里要按优先级取任务，静态数组我想到快速选择，但流式数据我更倾向大小为 k 的堆，这个方向可以吗？」这样问，提示来了你立刻能接住，面试官反而觉得你有工程判断力。明天 Day 5 的完整模拟面试（见 [Day 5](/week23/day5)）正好检验这套节奏。

图论题还有一条：动笔前把小样例画在纸上，节点、箭头、入度全标出来再写码。纸上多花一分钟，代码少改三轮。

## 常见踩坑

**坑 1：visited 标记放在出队时。** 同一节点会被重复塞进队列，BFS 结果失真。正确时机是入队那一刻。200 的沉岛同理：邻居格子进队前就把 `'1'` 改成 `'0'`，别等它出队再改。

**坑 2：Python 递归深度默认只有 1000。** 网格大到几百乘几百、又几乎全是陆地时，DFS 递归深度逼近格子总数，可能 RecursionError。要么用 `sys.setrecursionlimit()` 临时调高，要么直接换 BFS 迭代版，后者更稳。

**坑 3：第 k 大维护成最大堆。** 方向正好反了：要留住「最大的 k 个」，就得能快速弹掉「k 个里最小的那个」，所以是容量 k 的最小堆。写代码前先问自己一句：弹掉的是谁？答案应该是「目前榜上最弱的」。

**坑 4：207 的边方向建反。** `prerequisites[i] = [a, b]` 表示先修 b，所以边是 b → a（先修指向后修），入度记在 a 头上。建反了拓扑序整个颠倒。写完拿「先修 1 才能修 0」这个最小样例在纸上走一遍，方向对不对一目了然。

**坑 5：239 队列里存值不存下标。** 存值没法判断队头是否已经滑出窗口。存下标一举两得：值随时用 `nums[i]` 取，过期靠下标和窗口左边界比较。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. BFS 和 DFS 各用什么数据结构驱动？什么场景必须用 BFS？

::: details 参考答案
BFS 用队列（`deque` 加 `popleft`），DFS 用栈（显式栈或递归）。要算「最少步数、最短路径」（无权图）必须 BFS：它按距离一层层扩散，首次到达即最短。DFS 只回答「能不能到、走遍所有可达点」，代码更短。
:::

2. 200 题为什么不用开 visited 数组？什么时候必须开？

::: details 参考答案
因为允许原地改网格，把走过的 `'1'` 改成 `'0'`，改值本身就是标记，省掉 O(M×N) 额外空间。当题目不许修改原数据，或你不想破坏调用方的输入时，必须另开 visited 集合或复制一份网格。
:::

3. 207 判定可行的标准是什么？放到多 Agent 编排里，这个算法在防什么？

::: details 参考答案
标准是拓扑排序出队节点数等于课程总数，等价于有向图无环。放到多 Agent 编排里，防的是循环依赖：A 等 B 的输出、B 又等 A 的输出，整条流水线一个任务都启动不了，和课程修不完是同一个问题。
:::

4. 215 为什么维护「大小为 k 的最小堆」而不是最大堆？堆和快速选择各适合什么场景？

::: details 参考答案
堆里始终装着目前为止最大的 k 个数，堆顶是这 k 个里最小的，也就是当前第 k 大；新数只有比堆顶大才配挤掉它。堆解法 O(n log k)、空间 O(k)，天然适合流式数据；快速选择平均 O(n)，但要求数据在内存里且允许原地打乱，适合静态一次性查询。
:::

5. 239 的单调队列为什么整体是 O(n)？

::: details 参考答案
每个下标至多入队一次、出队一次（队尾弹出或队头清理），把出队操作摊到 n 次循环里，均摊单步 O(1)。判断要点是看「每个元素的生命周期是不是最多一进一出」，而不是盯着单层 while 循环数次数。
:::

## 延伸阅读

- LeetCode 中国站：[200. 岛屿数量](https://leetcode.cn/problems/number-of-islands/)、[207. 课程表](https://leetcode.cn/problems/course-schedule/)、[133. 克隆图](https://leetcode.cn/problems/clone-graph/)、[215. 数组中的第K个最大元素](https://leetcode.cn/problems/kth-largest-element-in-an-array/)、[239. 滑动窗口最大值](https://leetcode.cn/problems/sliding-window-maximum/)，今天 5 道题的原始出处，题解区挑高赞的对照
- [Python 官方文档：heapq](https://docs.python.org/zh-cn/3/library/heapq.html)，速查表的原始出处，`nlargest` / `nsmallest` 也在里面
- [labuladong 的算法笔记](https://labuladong.online/algo/)，图论和滑动窗口章节的模板讲得很细，适合查漏

今天 5 道 AC 的提交记录留好，后面聊多 Agent 编排和任务调度时，图和堆这两块直觉随时会被点名，这 5 份代码就是你的底气。
