from pathlib import Path
import argparse


def literal(value):
    return "'"+str(value).replace("'","''")+"'"


def identifier(value):
    return '"'+value.replace('"','""')+'"'


def main():
    parser = argparse.ArgumentParser(description='Профили Parquet/CSV → CSV для PARALLAX с осями G2/G3/G4')
    parser.add_argument('input',type=Path)
    parser.add_argument('--output',type=Path,default=Path(__file__).parent/'data/passengers.csv')
    args = parser.parse_args()
    source,target = args.input.expanduser().resolve(),args.output.expanduser().resolve()
    if source == target or source.is_dir() and source in target.parents:
        parser.error('Выходной CSV должен находиться отдельно от входных данных')
    if not source.exists():
        parser.error('Не найден '+str(source))
    try:
        import duckdb
    except ImportError:
        parser.error('Нужен duckdb: используйте Python из env аналитического проекта или pip install duckdb')
    con = duckdb.connect()
    con.execute('SET threads=1')
    con.execute("SET memory_limit='512MB'")
    if source.is_dir() or source.suffix.lower()=='.parquet':
        files = sorted(source.rglob('*.parquet')) if source.is_dir() else [source]
        if not files:
            parser.error('Во входной папке нет Parquet')
        scan = 'read_parquet(['+','.join(literal(p) for p in files)+'])'
    elif source.suffix.lower()=='.csv':
        scan = 'read_csv('+literal(source)+',header=true,all_varchar=true)'
    else:
        parser.error('Поддерживаются Parquet, папка частей Parquet и CSV')
    fields = {r[0] for r in con.execute('DESCRIBE SELECT * FROM '+scan).fetchall()}
    id_field = 'person_id' if 'person_id' in fields else 'passenger_id'
    score_field = 'target' if 'target' in fields else 'anomaly_score'
    if id_field not in fields or score_field not in fields:
        parser.error('Нужны person_id/target либо passenger_id/anomaly_score')
    axes = ['contribution_G2','contribution_G3','contribution_G4']
    if not set(axes)<=fields:
        axes = ['G2','G3','G4']
    if not set(axes)<=fields:
        parser.error('Нужны contribution_G2/G3/G4 либо G2/G3/G4')
    def number(field):
        value = identifier(field)
        return "CASE lower(trim(CAST("+value+" AS VARCHAR))) WHEN 'true' THEN 1.0 WHEN 'false' THEN 0.0 ELSE try_cast("+value+" AS DOUBLE) END"
    select = ['trim(CAST('+identifier(id_field)+' AS VARCHAR)) person_id',number(score_field)+' AS target']
    select.extend(number(field)+' AS '+identifier(field) for field in axes)
    for field in ['G2','G3','G4','reliable_segments','flight_count','core_mechanisms','signal_count','matched_hypotheses',
                  'cluster_id','unique_destinations','first_seen','last_seen','confidence','top_reason']:
        if field in fields and field not in axes:
            select.append(identifier(field))
    con.execute('CREATE VIEW profiles AS SELECT '+','.join(select)+' FROM '+scan)
    values = ['target',*axes]
    invalid = ' OR '.join(identifier(f)+' IS NULL OR NOT isfinite('+identifier(f)+') OR '+identifier(f)+'<0 OR '+identifier(f)+'>1' for f in values)
    count,unique,bad = con.execute("SELECT count(*),count(DISTINCT person_id),count(*) FILTER(WHERE person_id IS NULL OR person_id='' OR "+invalid+') FROM profiles').fetchone()
    if count != unique or bad:
        parser.error('Обнаружены пустые/повторные ID или некорректные значения осей/target; экспорт остановлен')
    target.parent.mkdir(parents=True,exist_ok=True)
    temp = target.with_suffix('.tmp.csv')
    con.execute('COPY profiles TO '+literal(temp)+' (HEADER, DELIMITER \',\')')
    temp.replace(target)
    con.close()
    print('Готово:',target,'\nПрофилей:',count,'\nX = G2, Y = G3, Z = G4')


if __name__ == '__main__':
    main()
