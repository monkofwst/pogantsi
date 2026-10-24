import argparse
from pathlib import Path
import numpy as np
import pandas as pd


def generate(output: Path, n: int = 100_000, seed: int = 42):
    rng = np.random.default_rng(seed)
    output.mkdir(parents=True, exist_ok=True)
    ids = np.array([f'P-{i:06d}' for i in range(1, n + 1)])
    flags = rng.random((n,3)) < np.array([.52,.48,.45])
    contributions = flags * np.array([.70,.60,.60]) * rng.uniform(.75,1.0,size=(n,3))
    cluster = flags[:,0].astype(int)+2*flags[:,1].astype(int)+4*flags[:,2].astype(int)
    score = 1-np.prod(1-contributions,axis=1)
    anomalous = score>=.8
    confidence = np.clip(rng.beta(8, 2, n), .05, 1)
    flight_count = np.maximum(1, rng.negative_binomial(3, .28, size=n) + 1)
    flight_count[anomalous] += rng.integers(3, 22, size=anomalous.sum())
    destinations = rng.integers(1, 19, size=n)
    destinations[anomalous] += rng.integers(2, 10, size=anomalous.sum())
    first_day = rng.integers(0, 900, n)
    last_day = np.minimum(first_day + rng.integers(30, 560, n), 1094)
    base = np.datetime64('2023-01-01')
    reasons = np.array(['G2: устойчивые спутники','G3: повторяющиеся цепочки','G4: всплеск и возвраты'],dtype=object)
    reason = reasons[np.argmax(contributions,axis=1)]
    reason[score==0] = 'Нет активных механизмов'
    profiles = pd.DataFrame({
        'passenger_id': ids, 'contribution_G2': contributions[:,0].round(5),
        'contribution_G3': contributions[:,1].round(5),'contribution_G4': contributions[:,2].round(5),
        'G2': flags[:,0],'G3': flags[:,1],'G4': flags[:,2],
        'target': score.round(5), 'confidence': confidence.round(5),'signal_count':flags.sum(axis=1),
        'cluster_id': cluster, 'flight_count': flight_count, 'unique_destinations': destinations,
        'first_seen': (base + first_day.astype('timedelta64[D]')).astype(str),
        'last_seen': (base + last_day.astype('timedelta64[D]')).astype(str),
        'top_reason': reason, 'is_synthetic': True
    })
    indices = np.arange(len(profiles))
    profiles['behavior_x'] = (indices % 997) / 996
    profiles['behavior_y'] = ((indices * 137) % 991) / 990
    profiles['behavior_z'] = ((indices * 233) % 983) / 982
    profiles.to_csv(output/'passengers.csv', index=False)

    m = n * 3
    owner = np.concatenate([np.arange(n), rng.choice(n, size=m-n, replace=True)])
    rng.shuffle(owner)
    airports = np.array(['SVO','DME','VKO','LED','KZN','SVX','OVB','AER','KGD','IST','DXB','BEG','EVN','TBS','GYD','ALA','TAS','BKK'])
    src = rng.integers(0, len(airports), size=m)
    dst = rng.integers(0, len(airports)-1, size=m)
    dst += (dst >= src)
    dep_day = rng.integers(0, 1095, size=m)
    dep_hour = rng.integers(0, 24, size=m)
    date = base + dep_day.astype('timedelta64[D]')
    events = pd.DataFrame({
       'event_id': [f'F-{i:07d}' for i in range(1,m+1)],
       'passenger_id': ids[owner],
       'flight_date': date.astype(str),
       'departure_hour': dep_hour,
       'origin': airports[src], 'destination': airports[dst],
       'source': rng.choice(['booking_site','agency','forum','loyalty_program'],m),
       'is_synthetic': True
    })
    events.sort_values(['passenger_id','flight_date'], inplace=True, kind='stable')
    events.to_csv(output/'flights.csv', index=False)
    grouped = events.groupby('passenger_id', sort=False)
    aggregates = grouped.agg(flight_count=('event_id', 'size'),
                             unique_destinations=('destination', 'nunique'),
                             first_seen=('flight_date', 'min'),
                             last_seen=('flight_date', 'max'))
    for field in aggregates.columns:
        profiles[field] = profiles['passenger_id'].map(aggregates[field])
    profiles.to_csv(output/'passengers.csv', index=False)
    print(f'Generated {len(profiles):,} passengers and {len(events):,} flights in {output}')
    print('IMPORTANT: all scores, coordinates and flights are synthetic demo data, not ML model outputs.')

if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--out', type=Path, default=Path('demo_data'))
    p.add_argument('--passengers', type=int, default=100_000)
    p.add_argument('--seed', type=int, default=42)
    a = p.parse_args()
    generate(a.out, a.passengers, a.seed)
