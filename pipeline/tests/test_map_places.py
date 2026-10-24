from ski_sim_pipeline.build import map_places
from ski_sim_pipeline.config import Extent


class Frame:
    """Local metres = lon/lat × 1000, for a test."""

    def to_local(self, lon, lat):
        return lon * 1000, lat * 1000


def node(name, kind, lon, lat, **tags):
    return {"type": "node", "lon": lon, "lat": lat, "tags": {"name": name, "place": kind, **tags}}


def test_places_for_map_labels_are_ranked_and_deduplicated():
    places = [
        node("Hameau", "hamlet", 1, 1),
        node("Méribel", "village", 2, 2),
        node("Méribel", "village", 2.1, 2),  # mapped twice, 100 m apart
        node("Moûtiers", "town", 3, 3),
        node("Far away", "village", 50, 50),  # off the map
        node("Банско", "town", 4, 4),  # transliterated
        node("Lieu-dit", "locality", 5, 5),  # not a settlement
    ]
    out = map_places(places, Frame(), Extent(0, 10_000, 0, 10_000))
    assert [(p["name"], p["kind"]) for p in out] == [
        ("Bansko", "town"),
        ("Moûtiers", "town"),
        ("Méribel", "village"),
        ("Hameau", "hamlet"),
    ]
