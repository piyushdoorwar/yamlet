using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using Yamlet.App.Models;

namespace Yamlet.App.ViewModels;

/// <summary>
/// Base node in the workspace tree. Concrete subclasses represent collections,
/// folders and requests; views select a template based on the runtime type.
/// </summary>
public abstract partial class TreeNodeViewModel : ViewModelBase
{
    [ObservableProperty]
    private string _name = string.Empty;

    [ObservableProperty]
    private bool _isExpanded = true;

    public ObservableCollection<TreeNodeViewModel> Children { get; } = new();

    /// <summary>The parent node, or null for top-level collection nodes.</summary>
    public TreeNodeViewModel? Parent { get; init; }
}

/// <summary>A collection node. Children are its folders and direct requests.</summary>
public sealed class CollectionNodeViewModel : TreeNodeViewModel
{
    public required YamletCollection Collection { get; init; }
}

/// <summary>A folder node within a collection.</summary>
public sealed class FolderNodeViewModel : TreeNodeViewModel
{
    public required YamletFolder Folder { get; init; }
    public required YamletCollection OwningCollection { get; init; }
}

/// <summary>A request leaf node, carrying its HTTP method for badge display.</summary>
public sealed partial class RequestNodeViewModel : TreeNodeViewModel
{
    public required YamletRequest Request { get; init; }
    public required YamletCollection OwningCollection { get; init; }
    public YamletFolder? ParentFolder { get; init; }

    [ObservableProperty]
    private string _method = "GET";

    /// <summary>Uppercased method text shown in the method badge.</summary>
    public string MethodBadge => string.IsNullOrWhiteSpace(Method) ? "GET" : Method.ToUpperInvariant();
}
