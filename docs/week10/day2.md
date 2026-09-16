# 第 10 周 · Day 2：Pydantic 请求体 + 响应模型——入口校验，出口过滤

> 对应手册任务：学习「Pydantic 请求体 + 响应模型」，动手实现 `/users` 的 POST，用 Pydantic 校验请求体，当日产出「带校验的 POST」。本篇只解决一个问题：昨天 Day 1 的接口，参数全来自 URL，路径参数和查询参数 FastAPI 都替你转换好了；今天要接收客户端 POST 上来的 JSON 请求体，谁来保证这坨数据可信？谁来保证我们发回去的 JSON 不多不少、绝不捎带密码哈希？答案是进出口各立一道 Pydantic 闸门，而接线只需要一个类型注解。

## 今日目标

1. 说得清请求模型和响应模型各挡住什么风险，以及 NestJS「DTO + ValidationPipe 两步走」和 FastAPI「注解一步到位」差在哪
2. 掌握三个语法点：`BaseModel` 直接做参数注解、`Field` 约束与 `EmailStr`、`response_model` 过滤与契约
3. 独立完成带校验的 POST `/users`：合法请求拿到 201 + Location，非法请求拿到结构化的 422，两例都用 curl 亲自验证

## 概念讲解：为什么进出口都要有模型

先看没有请求模型的世界。客户端 POST 一段 JSON 过来，你把参数注解写成 `dict`，FastAPI 会把解析好的 JSON 字典直接交给你，然后呢？

```python
@app.post("/users")
def create_user(payload: dict):
    if "name" not in payload or "email" not in payload or "password" not in payload:
        return {"error": "missing fields"}
    if len(payload["name"]) < 2:
        return {"error": "name too short"}
    if "@" not in payload["email"]:
        return {"error": "email is invalid"}
    user = {"id": len(users_db) + 1, **payload}
    users_db.append(user)
    return user
```

十几行，四个雷。第一，校验全靠手写 if 链，字段一多就失控，而且 `len(payload["name"]) < 2` 这种行要不要写、写成什么样，每个接口都不一样。第二，错误格式随手拼，前端拿到 `{"error": "..."}` 没法统一处理。第三，`**payload` 把客户端传的所有字段照单全收，人家塞一个 `"is_admin": true` 进来，你也存进库。第四，最后一行 `return user` 把存进去的密码原样吐回响应，等于把门禁卡贴在大门上。

其实这些活你早就会干了。第 9 周 Day 4 你用 Pydantic 定义过带邮箱格式和范围校验的模型：`BaseModel`、`Field`、类型不对就报错，一样不缺。当时缺的只有一件事：模型是模型，没接到 HTTP 上。FastAPI 的答案简单到离谱：把模型类直接写进函数签名的类型注解里。解析 JSON、类型转换、跑校验、校验失败回 422，一条链全自动，你的函数体里只剩业务。

## 核心知识

本节的代码块都是独立片段，改在昨天的 `main.py` 里就能跑，最终完整文件以下面的动手任务为准。

### 1. 请求模型：注解即接线

```python
from pydantic import BaseModel, EmailStr, Field

class UserCreate(BaseModel):
    name: str = Field(min_length=2, max_length=20)
    email: EmailStr
    password: str = Field(min_length=8)


@app.post("/users", status_code=201)
def create_user(payload: UserCreate):
    return {"got": payload.name}
```

关键在 `payload: UserCreate` 这一行注解。FastAPI 检查每个参数的类型注解，规则一句话：注解是 `BaseModel` 的子类，这个参数就是请求体。框架负责读 body、解析 JSON、执行 Pydantic 校验，任何一步失败直接回 422，你的路由函数根本不会被执行。函数体内拿到的 `payload` 已经是校验通过的 `UserCreate` 实例，`payload.name` 必然是 2 到 20 个字符的字符串，这个前提由框架担保，不用你再写一行 if。

对照昨天：`user_id: int` 这种标量注解被认成路径参数。分界线就一条：标量走路径和查询，模型走请求体。一个签名里混着用也各走各的。

`Field` 的约束参数和第 9 周用法完全一样，今天不重复讲。新增的只有 `EmailStr`：它不是 Pydantic 自带，要装可选依赖 `pip install "pydantic[email]"`，不装的话导入这行直接报 `ImportError`。

说到这，对照一下你在第 3 周 NestJS 里写过的方式：

```ts
// 第一步：DTO + class-validator 装饰器，把校验规则再写一遍
export class CreateUserDto {
  @IsString() @MinLength(2)
  name: string;

  @IsEmail()
  email: string;
}

// 第二步：main.ts 里开全局管道，漏了这步校验形同虚设
app.useGlobalPipes(new ValidationPipe());
```

两步缺一不可：DTO 不挂管道，装饰器全是摆设。为什么 NestJS 必须两步？因为 TypeScript 的类型信息编译后就被擦掉了（[第 1 周教程](/week01/)讲泛型擦除时说过，泛型如此，普通类型注解也如此），运行时框架根本不知道 `name` 是 string，校验规则只能靠装饰器这种「运行时还活着」的元数据另写一份，再靠管道统一触发。Python 不一样：类型注解在运行时完整可读，Pydantic 模型本身就是一份能执行的 schema。FastAPI 读注解就够了，这就是一步到位的本质。

### 2. 响应模型：出口的闸门

入口的问题解决了，出口还漏着风。存用户时要把密码变成哈希存进库，这行字典里有 `hashed_password`，直接 `return user` 就是原样序列化，哈希直接外泄。给路由再加一个参数：

```python
class UserResponse(BaseModel):
    id: int
    name: str
    email: EmailStr


@app.post("/users", status_code=201, response_model=UserResponse)
def create_user(payload: UserCreate):
    ...
    return user  # user 里有 hashed_password，但出不去
```

关键在 `response_model=UserResponse`：FastAPI 把返回值在这个模型里过一遍，模型里没有的字段直接丢弃，等于出口挂了一张白名单。`hashed_password` 进得了库，出不了门。这个参数还顺手干了第二件事：`/docs` 交互文档里这个接口的响应形状固定成 UserResponse，前端照着写类型、生成客户端，契约白纸黑字。NestJS 那边对应的是 `ClassSerializerInterceptor` 配 `@Exclude()`，或者手动挑字段；FastAPI 是在路由上声明一行，模型即文档。这个参数对所有方法生效，昨天写的 `GET /users/{id}` 同样可以挂。

### 3. 出入分离：Create / Update / Response 三件套

为什么不定义一个 User 模型管所有事？因为入口描述「客户端该提供什么」，出口描述「服务端愿意回什么」，两边字段天生不同：请求里该有密码、不该有 id；响应里该有 id、绝不该有密码。共用一个模型，要么字段不够用，要么字段拦不住，拦不住的部分就是攻击面。所以惯例是三个模型各管一段：

```python
class UserCreate(BaseModel):
    name: str = Field(min_length=2, max_length=20)
    email: EmailStr
    password: str = Field(min_length=8)


class UserUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=20)
    email: EmailStr | None = None


class UserResponse(BaseModel):
    id: int
    name: str
    email: EmailStr
```

UserCreate 管注册：字段必填，约束拉满。UserUpdate 管以后的 PATCH：全字段可选，`str | None = None` 表示「不传就当没这回事」，只传 name 就只改 name，这正是当年 NestJS 里 `PartialType(CreateUserDto)` 干的事。UserResponse 管出口：id 由服务端生成，密码和哈希永远缺席。UserUpdate 今天先摆上桌立规矩，动手任务只用 Create 和 Response 两个。

## 动手任务：带校验的 POST 一步一步

手册任务：实现 `/users` 的 POST，用 Pydantic 校验请求体。在昨天 Day 1 的 `main.py` 上继续改，拆成 5 步，全程约 25 分钟。

**第 1 步：装依赖、起服务。** `EmailStr` 需要额外的校验库，执行 `pip install "pydantic[email]"`（注意引号，别让 shell 把方括号当通配符）。服务按昨天的方式起着：`uvicorn main:app --reload`，后面每步保存后它会自动重载。

**第 2 步：定义模型和存储。** 在 `main.py` 顶部补上这些，昨天已有的 `/health` 和 `GET /users/{id}` 原样保留：

```python
import hashlib

from pydantic import BaseModel, EmailStr, Field

users_db: list[dict] = []
next_id = 1


class UserCreate(BaseModel):
    name: str = Field(min_length=2, max_length=20)
    email: EmailStr
    password: str = Field(min_length=8)


class UserUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=20)
    email: EmailStr | None = None


class UserResponse(BaseModel):
    id: int
    name: str
    email: EmailStr
```

`users_db` 是模块级列表，今天先冒充数据库，Day 4 换成 SQLAlchemy。`next_id` 模拟自增主键。真正的密码哈希用 `hashlib` 一行就能算，标准库，不用装东西。

**第 3 步：写 POST 路由。** 导入补齐 `from fastapi import FastAPI, HTTPException, Response`，然后加路由：

```python
@app.post("/users", status_code=201, response_model=UserResponse)
def create_user(payload: UserCreate, response: Response):
    global next_id
    for u in users_db:
        if u["email"] == payload.email:
            raise HTTPException(status_code=400, detail="email already registered")
    user = {
        "id": next_id,
        "name": payload.name,
        "email": payload.email,
        "hashed_password": hashlib.sha256(payload.password.encode()).hexdigest(),
    }
    next_id += 1
    users_db.append(user)
    response.headers["Location"] = f"/users/{user['id']}"
    return user
```

四个要点。`status_code=201`：POST 创建资源成功，规范动作是 201 Created 而不是默认的 200。`response: Response` 这个参数：注解成 `Response` 时 FastAPI 会把响应对象注进来，先塞 header 再正常 return，两不耽误；Location 指向新资源的地址，是 REST 的基本礼貌。那条 for 循环是业务规则：邮箱有没有被注册，Pydantic 管不着，只能自己查，业务拒绝用 400，和校验失败的 422 各归各位。最后，`hashlib.sha256(...).hexdigest()` 算演示版哈希，生产环境换 bcrypt 这类慢哈希，这个坑先记下。

**第 4 步：curl 验证合法请求。**

```bash
curl -i -X POST http://127.0.0.1:8000/users \
  -H "Content-Type: application/json" \
  -d '{"name": "Jerry", "email": "jerry@example.com", "password": "secret123"}'
```

`-i` 会把响应头打出来。确认三件事：状态码是 201；头里有 `location: /users/1`；响应体只有 id、name、email 三个字段，password 没回去，hashed_password 也没有。Windows 用户建议在 Git Bash 里跑这条命令，PowerShell 对单引号和 JSON 的转义规则是另一个世界。

**第 5 步：curl 验证非法请求，读懂 422。** 这次故意把 name 弄短、email 弄坏：

```bash
curl -i -X POST http://127.0.0.1:8000/users \
  -H "Content-Type: application/json" \
  -d '{"name": "J", "email": "not-an-email", "password": "secret123"}'
```

状态码 422，响应体长这样（两条错误都收在数组里；具体文案随版本可能略有出入，字段结构是稳定的）：

```json
{
  "detail": [
    {
      "type": "string_too_short",
      "loc": ["body", "name"],
      "msg": "String should have at least 2 characters",
      "input": "J"
    },
    {
      "type": "value_error",
      "loc": ["body", "email"],
      "msg": "value is not a valid email address: An email address must have an @-sign.",
      "input": "not-an-email"
    }
  ]
}
```

三段各有分工。`loc` 是错误位置，从外到内：body 里的 name 字段；嵌套模型时这条路还会继续往里长。`type` 是违反的规则名，机器可读：`string_too_short`、漏传字段时的 `missing`、格式错误的 `value_error` 都在这一列。`msg` 是给人看的说明。前端拿 `loc` 定位到具体表单项，拿 `type` 映射提示文案，不用去解析 msg 字符串。再看一眼你的路由函数：这批 422 是框架在函数体外生成的，`create_user` 一行都没执行。

::: tip 交互文档
打开 http://127.0.0.1:8000/docs 找到 POST /users：请求 Schema 是 UserCreate，响应 Schema 是 UserResponse，这是 response_model 顺手生成的文档。点 Try it out 直接发请求，把字段改坏再执行，422 错误体原样躺在响应区，比 curl 还直观。
:::

## 常见踩坑

**坑 1：直接返回 JSONResponse 会绕过 response_model。** 想自定义响应时手痒写成 `return JSONResponse(status_code=201, content=user)`，过滤当场失效，hashed_password 照样漏出去。FastAPI 的规则：函数直接返回 Response 对象时，不再做序列化和过滤。正确姿势就是第 3 步用的 `response: Response` 注入，header 提前塞好，返回值照常交给 response_model 把关。

**坑 2：EmailStr 的 ImportError。** 报 `ImportError: email-validator is not installed` 不是 FastAPI 的 bug，Pydantic 把邮箱校验拆成了可选依赖。`pip install "pydantic[email]"` 装上、重启服务就好。这也是个提醒：报错先读完最后那行，它通常直接写着答案。

**坑 3：一个模型包打天下，等于给攻击者开字段。** 图省事只定义一个 User(BaseModel) 同时当请求和响应：客户端传 `"is_admin": true`、`"id": 999` 会被照单全收（还记得概念讲解里那个 `**payload` 吗）；响应侧又没法不给 id。进和出的诉求本来就相反，Create/Update/Response 三件套不是仪式感，是安全边界。

**坑 4：UserUpdate 里 None 有两副面孔。** `name: str | None = None` 时，「没传 name」和「传了 `"name": null`」都变成 None，PATCH 时分不清「不改」和「改成空」。解法是 `payload.model_dump(exclude_unset=True)`，只取客户端真正传过的字段。今天用不上，写更新接口那天你会回来谢这条。

**坑 5：422 和 400 别混着用。** 422 是「请求体不合格」，格式和约束层面的错，框架自动回；400 是「请求合法但业务拒绝」，比如邮箱已注册，需要自己 raise。前端要靠这两个码区分「提示用户改输入框」和「提示用户换邮箱」。别手动 raise 422 去做字段校验，框架做得比你好；更别把 422 捕获后包成 200 塞进 code 字段，那是在拆 FastAPI 的台。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. FastAPI 靠什么判断一个函数参数是请求体、路径参数还是查询参数？

::: details 参考答案
看类型注解。注解是 BaseModel 子类，参数是请求体，框架负责解析和校验 JSON；注解是标量（int、str、bool 等）且名字出现在路径模板里，是路径参数；其余标量走查询参数。一个签名里混合出现各走各的，第 3 步的 create_user 就同时有请求体和 Response 注入。
:::

2. `response_model` 同时提供了哪两重保障？

::: details 参考答案
一是过滤：返回值在模型里过一遍，模型没有的字段被丢弃，密码哈希出不了门；二是契约：`/docs` 里该接口的响应形状固定为这个模型，前端照文档写类型、生成客户端。返回 dict 还是对象都行，出口形状由模型说了算。
:::

3. NestJS 校验要 DTO 加全局 ValidationPipe 两步，FastAPI 只需一个注解，根本原因是什么？

::: details 参考答案
TypeScript 的类型信息编译后即被擦除，运行时框架看不到 `name: string`，校验规则只能靠 class-validator 装饰器另写一份运行时元数据，再靠全局管道统一触发，少一步就静默失效。Python 的类型注解运行时完整可读，Pydantic 模型本身就是可执行的 schema，FastAPI 读注解就能一次完成解析、校验和报错。
:::

4. 422 错误体里 `loc`、`type`、`msg` 各是什么？漏传 password 时那条错误长什么样？

::: details 参考答案
`loc` 是错误位置的路径，从外到内，如 `["body", "email"]`；`type` 是机器可读的规则名；`msg` 是给人读的说明。漏传 password 时 `type` 是 `missing`，`loc` 是 `["body", "password"]`。前端用 `loc` 对到表单字段，用 `type` 映射提示文案。
:::

5. 入口和出口为什么要用不同的模型？UserUpdate 怎么表达「所有字段可选」？

::: details 参考答案
入口模型描述客户端该提供什么（password 必填、id 不许传），出口模型描述服务端愿意返回什么（id 一定有、密码绝不出现），两边字段集天然不同。共用一个模型要么不够用要么拦不住，拦不住的字段就是攻击面。UserUpdate 用 `str | None = None`、`EmailStr | None = None` 把每个字段设为可选，配合 `exclude_unset=True` 实现只改传过的字段。
:::

## 延伸阅读

- [FastAPI 官方教程：Request Body](https://fastapi.tiangolo.com/tutorial/body/)，请求模型与路径、查询参数混用的原始出处，所有示例可在线运行
- [FastAPI 官方教程：Response Model](https://fastapi.tiangolo.com/tutorial/response-model/)，response_model 的过滤与文档作用，末尾「别用大模型当响应」的性能提醒值得一看
- [Pydantic v2 文档：Fields](https://docs.pydantic.dev/latest/concepts/fields/)，`Field` 全部约束参数与默认值行为，第 9 周没查完的部分这里补齐

今天的 `main.py` 留好，凑近已经能闻到馊味：路由函数里混着存储读写、业务规则和 HTTP 细节。Day 3 就动刀分层，重复注册那条 for 循环会搬进 service 层，`users_db` 会沉到 repository 层，[本周日程](/week10/)里这叫 router → service → repository。
