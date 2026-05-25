"""
数据初始化脚本
删除旧数据库，重建表结构，导入SPN场景测试数据
"""
import json
import shutil
from pathlib import Path

import pandas as pd

import sys
sys.path.insert(0, str(Path(__file__).parent))

from database import engine, SessionLocal, Base
from models import Scene, ExcelFile, ExcelRow, Prompt, KnowledgeFile, RuleConfig

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "db.sqlite"
TEST_DATA_PATH = BASE_DIR.parent / "test_data.xlsx"
PROMPTS_DIR = BASE_DIR / "prompts"
KNOWLEDGE_DIR = BASE_DIR / "knowledge"
CONFIG_DIR = BASE_DIR / "config"
DATA_DIR = BASE_DIR / "data"


def init():
    # 1. 删除旧数据库
    if DB_PATH.exists():
        DB_PATH.unlink()
        print("✓ 已删除旧数据库")

    # 2. 创建所有表
    Base.metadata.create_all(bind=engine)
    print("✓ 已创建所有表")

    # 3. 创建目录结构
    for sub in ["datasets/SPN", "prompts/SPN", "knowledge/SPN", "rules", "error_books", "exports"]:
        (DATA_DIR / sub).mkdir(parents=True, exist_ok=True)
    print("✓ 已创建目录结构")

    db = SessionLocal()
    try:
        # 4. 创建SPN场景
        scene = Scene(name="SPN", description="SPN标注测试场景")
        db.add(scene)
        db.flush()
        print(f"✓ 已创建SPN场景 (id={scene.id})")

        # 5. 导入规则配置
        rule_json = json.loads((CONFIG_DIR / "rule.json").read_text(encoding="utf-8"))
        rule = RuleConfig(
            scene_id=scene.id,
            annotate_fields=json.dumps(rule_json["annotate_fields"], ensure_ascii=False),
            answer_field=rule_json["answer_field"],
            result_label_field=rule_json["result_label_field"],
            excel_fields=json.dumps(rule_json.get("excel_fields", []), ensure_ascii=False),
        )
        db.add(rule)
        print("✓ 已导入规则配置")

        # 6. 导入test_data.xlsx
        if TEST_DATA_PATH.exists():
            df = pd.read_excel(TEST_DATA_PATH)
            dest_path = DATA_DIR / "datasets" / "SPN" / "test_data.xlsx"
            shutil.copy2(TEST_DATA_PATH, dest_path)

            columns_info = list(df.columns)
            answer_field = rule_json["answer_field"]

            excel_file = ExcelFile(
                file_name="test_data.xlsx",
                original_file_name="test_data.xlsx",
                scene_id=scene.id,
                total_rows=len(df),
                annotated_count=int(df[answer_field].notna().sum()) if answer_field in df.columns else 0,
                columns_info=json.dumps(columns_info, ensure_ascii=False),
                file_path=str(dest_path),
            )
            db.add(excel_file)
            db.flush()

            for idx, row in df.iterrows():
                row_dict = {}
                for col in df.columns:
                    val = row[col]
                    row_dict[col] = None if pd.isna(val) else val

                human_answer = row_dict.get(answer_field)
                if human_answer is not None:
                    human_answer = str(human_answer).strip()

                excel_row = ExcelRow(
                    file_id=excel_file.id,
                    file_name="test_data.xlsx",
                    row_index=int(idx) + 1,
                    data=json.dumps(row_dict, ensure_ascii=False, default=str),
                    human_answer=human_answer,
                )
                db.add(excel_row)

            print(f"✓ 已导入test_data.xlsx ({len(df)}行)")
        else:
            print("⚠ test_data.xlsx 不存在，跳过")

        # 7. 导入Prompt文件
        prompt_count = 0
        for prompt_file in sorted(PROMPTS_DIR.glob("*.prompt")):
            content = prompt_file.read_text(encoding="utf-8")
            name = prompt_file.stem
            prompt = Prompt(
                scene_id=scene.id,
                name=name,
                content=content,
                file_type=".prompt",
            )
            db.add(prompt)
            dest = DATA_DIR / "prompts" / "SPN" / prompt_file.name
            shutil.copy2(prompt_file, dest)
            prompt_count += 1
        print(f"✓ 已导入 {prompt_count} 个Prompt文件")

        # 8. 导入知识文件
        knowledge_path = KNOWLEDGE_DIR / "test.txt"
        if knowledge_path.exists():
            content = knowledge_path.read_text(encoding="utf-8")
            knowledge = KnowledgeFile(
                scene_id=scene.id,
                name="test.txt",
                content=content,
                file_type=".txt",
            )
            db.add(knowledge)
            dest = DATA_DIR / "knowledge" / "SPN" / "test.txt"
            shutil.copy2(knowledge_path, dest)
            print("✓ 已导入知识文件 test.txt")
        else:
            print("⚠ test.txt 不存在，跳过")

        db.commit()
        print("\n✅ 数据初始化完成！")

    except Exception as e:
        db.rollback()
        print(f"\n❌ 初始化失败: {e}")
        raise
    finally:
        db.close()


if __name__ == "__main__":
    init()
