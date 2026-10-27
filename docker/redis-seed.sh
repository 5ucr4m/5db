#!/bin/sh
# Populates the test Redis with every value type 5db renders.
cd "$(dirname "$0")" && R="docker compose exec -T redis redis-cli -a fivedb --no-auth-warning"
{
  echo "DEL queue:emails events:orders tags:popular leaderboard"
  for i in $(seq 1 300); do echo "SET session:user:$i token-$i-abc EX $((86400 + i * 60))"; done
  for i in $(seq 1 50); do echo "HSET user:$i name User$i email user$i@example.com plan pro"; done
  echo "SET config:feature_flags '{\"darkMode\":true,\"beta\":[\"search\",\"export\"]}'"
  echo "RPUSH queue:emails welcome reset-password invoice newsletter"
  echo "SADD tags:popular redis postgres tauri rust react"
  echo "ZADD leaderboard 1200 ana 980 bruno 1530 carla 720 diego"
  echo "XADD events:orders * order 1 status paid"
  echo "XADD events:orders * order 2 status shipped"
  echo "SET counter:visits 4242"
  echo "SELECT 1"
  echo "SET cache:db1:hello world"
} | $R >/dev/null
$R DBSIZE
