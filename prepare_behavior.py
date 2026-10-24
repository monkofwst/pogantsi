import argparse
from pathlib import Path


def quote(value):
    return "'" + str(value).replace("'", "''") + "'"


def scan(path):
    path = path.expanduser().resolve()
    if path.is_dir():
        files = sorted(path.rglob('*.parquet'))
        if not files:
            raise ValueError('В папке нет Parquet: ' + str(path))
        return 'read_parquet([' + ','.join(map(quote, files)) + '])'
    if path.suffix.lower() == '.csv':
        return 'read_csv(' + quote(path) + ',header=true)'
    return 'read_parquet(' + quote(path) + ')'


def main():
    parser = argparse.ArgumentParser(description='Координаты поведения + исходный target для PARALLAX')
    parser.add_argument('scores', type=Path)
    parser.add_argument('--metrics', type=Path, default=Path(__file__).parent / 'data/metrics.parquet')
    parser.add_argument('--output', type=Path, default=Path(__file__).parent / 'data/passengers.csv')
    args = parser.parse_args()
    try:
        import duckdb
        con = duckdb.connect()
        con.execute("SET memory_limit='512MB'")
        con.execute('SET threads=2')
        if args.output.resolve() in (args.scores.resolve(), args.metrics.resolve()):
            raise ValueError('Выход должен отличаться от входных файлов')
        con.execute('CREATE VIEW s AS SELECT * FROM ' + scan(args.scores))
        con.execute('CREATE VIEW m AS SELECT * FROM ' + scan(args.metrics))
        fields = {r[0] for r in con.execute('DESCRIBE s').fetchall()}
        if not {'person_id', 'target'} <= fields:
            raise ValueError('Нужна таблица users_scored с person_id и target')
        for table in ['s', 'm']:
            total, unique = con.execute('SELECT count(*),count(DISTINCT person_id) FROM ' + table).fetchone()
            if total != unique:
                raise ValueError('Повторные или пустые ID в ' + table)
        missing = con.execute('SELECT count(*) FROM s ANTI JOIN m USING(person_id)').fetchone()[0]
        if missing:
            raise ValueError(str(missing) + ' ID из scores отсутствуют в metrics: несовместимые входы')
        invalid = con.execute('SELECT count(*) FROM s WHERE try_cast(target AS DOUBLE) IS NULL OR NOT isfinite(try_cast(target AS DOUBLE)) OR try_cast(target AS DOUBLE) NOT BETWEEN 0 AND 1').fetchone()[0]
        if invalid:
            raise ValueError('Некорректный target: ' + str(invalid))
        con.execute('''CREATE VIEW profiles AS SELECT s.*,
            CASE WHEN m.n>0 AND m.social_coverage IS NOT NULL THEN m.social_coverage END AS behavior_x,
            CASE WHEN m.n>1 AND m.pair_n IS NOT NULL THEN m.pair_n::DOUBLE/(m.n-1)
                 WHEN m.n=1 THEN 0.0 END AS behavior_y,
            CASE WHEN m.month_burst>=1 THEN 1.0-1.0/m.month_burst END AS behavior_z,
            m.social_coverage AS raw_social_coverage,
            m.pair_n AS raw_pair_n, m.n AS raw_segments,
            m.month_burst AS raw_month_burst,
            m.first_day AS first_seen, m.last_day AS last_seen
            FROM s LEFT JOIN m USING(person_id)''')
        count, available = con.execute('SELECT count(*),count(*) FILTER(WHERE behavior_x IS NOT NULL AND behavior_y IS NOT NULL AND behavior_z IS NOT NULL) FROM profiles').fetchone()
        target = args.output.expanduser().resolve()
        target.parent.mkdir(parents=True, exist_ok=True)
        temp = target.with_suffix('.tmp.csv')
        con.execute('COPY profiles TO ' + quote(temp) + " (HEADER, DELIMITER ',')")
        temp.replace(target)
        print('Готово:', target)
        print('Всего профилей:', count, '| С координатами:', available, '| Без полных координат:', count-available)
        print('target сохранён без пересчёта. Все строки сохранены; пустые координаты означают нехватку данных.')
    except (ImportError, ValueError, OSError) as error:
        parser.exit(1, str(error) + '\n')


if __name__ == '__main__':
    main()
