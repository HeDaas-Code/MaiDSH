#!/usr/bin/env python3
"""把本地 MaiDSH 仓库的提交历史，通过 GitHub REST API 重放到远端。

为什么不用 git push：这台机器的 443 到 github.com 是断的（超时），
只有 api.github.com 通。所以走 Blobs/Trees/Commits/Refs 四个 API 手工建提交，
保留原始的提交信息与作者时间，而不是压成一个 squash。
"""
import base64
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

WORKDIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OWNER, REPO = "HeDaas-Code", "MaiDSH"
TOK = os.environ["GITHUB_TOKEN"]


def api(method, path, data=None):
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request("https://api.github.com" + path, data=body, method=method)
    req.add_header("Authorization", "Bearer " + TOK)
    req.add_header("Accept", "application/vnd.github+json")
    if body:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        sys.exit("API %s %s -> %s: %s" % (method, path, e.code, e.read().decode()[:500]))


def git(*args, binary=False):
    out = subprocess.run(["git"] + list(args), cwd=WORKDIR, capture_output=True, check=True)
    return out.stdout if binary else out.stdout.decode()


def meta(sha, fmt):
    return git("show", "-s", "--format=" + fmt, sha).strip("\n")


commits = git("rev-list", "--reverse", "HEAD").split()
print("本地提交 %d 个" % len(commits))

# 空仓库上 Blobs API 会回 409「Git Repository is empty」，所以先拿 Contents API
# 塞一个占位文件把仓库激活。它生成的那个 bootstrap 提交随后会被 force 覆盖成
# 真正的根提交，成为不可达对象，GitHub 自己会回收。
try:
    api("PUT", "/repos/%s/%s/contents/.bootstrap" % (OWNER, REPO), {
        "message": "chore: bootstrap repository",
        "content": base64.b64encode(b"bootstrap\n").decode(),
    })
    print("已激活空仓库")
except SystemExit as e:
    print("bootstrap 跳过:", e)

parent_gh = None
for sha in commits:
    subject = meta(sha, "%s")
    message = meta(sha, "%B")
    author_name = meta(sha, "%an")
    author_email = meta(sha, "%ae")
    author_date = meta(sha, "%aI")

    # 每个提交建一棵「全量快照树」：不做 diff，省掉删除/改名的是非判断
    entries = []
    listing = git("ls-tree", "-r", sha).splitlines()
    for line in listing:
        left, path = line.split("\t", 1)
        mode, otype, blob = left.split()
        if otype != "blob":
            continue
        content = git("show", "%s:%s" % (sha, path), binary=True)
        created = api("POST", "/repos/%s/%s/git/blobs" % (OWNER, REPO), {
            "content": base64.b64encode(content).decode(),
            "encoding": "base64",
        })
        entries.append({"path": path, "mode": mode, "type": "blob", "sha": created["sha"]})

    tree = api("POST", "/repos/%s/%s/git/trees" % (OWNER, REPO), {"tree": entries})
    payload = {"message": message, "tree": tree["sha"], "author": {
        "name": author_name, "email": author_email, "date": author_date}}
    if parent_gh:
        payload["parents"] = [parent_gh]
    commit = api("POST", "/repos/%s/%s/git/commits" % (OWNER, REPO), payload)
    parent_gh = commit["sha"]
    print("  %s  %s  -> %s (%d 文件)" % (sha[:7], subject[:48], parent_gh[:7], len(entries)))

api("PATCH", "/repos/%s/%s/git/refs/heads/main" % (OWNER, REPO), {"sha": parent_gh, "force": True})
final = api("GET", "/repos/%s/%s" % (OWNER, REPO))
print("远端 main ->", final["default_branch"], "| 提交数:", final.get("size"))
print("URL:", final["html_url"])
